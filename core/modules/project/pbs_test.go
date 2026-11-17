package project

import (
	"net/http"
	"strings"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
)

func (f *fixture) pbsItem(project uuid.UUID, parent *uuid.UUID) uuid.UUID {
	return f.id(`INSERT INTO project_pbs_item (tenant_id, project_id, parent_id, name, x, y) VALUES ($1, $2, $3, 'D', 0, 0) RETURNING id`,
		f.tenant, project, parent)
}

func (f *fixture) linkPbs(task, item uuid.UUID) {
	f.exec(`UPDATE project_task SET pbs_item_id = $2 WHERE id = $1`, task, item)
}

func TestPbs_ManagerOnly(t *testing.T) {
	f := newFixture(t)
	m, mem := uuid.New(), uuid.New()
	me, member := f.caller(m), f.caller(mem)
	p := f.project(m, "members")
	f.member(p, mem)
	item := f.pbsItem(p, nil)
	f.run(t, []writeCase{
		{"member creates", member, http.MethodPost, "project_pbs_item", map[string]any{"project_id": p, "name": "D"}, 403},
		{"member updates", member, http.MethodPut, "project_pbs_item/" + item.String(), map[string]any{"name": "X"}, 403},
		{"member deletes", member, http.MethodDelete, "project_pbs_item/" + item.String(), nil, 403},
		{"stranger updates", f.caller(uuid.New()), http.MethodPut, "project_pbs_item/" + item.String(), map[string]any{"x": 5}, 404},
		{"manager creates", me, http.MethodPost, "project_pbs_item", map[string]any{"project_id": p, "name": "Other"}, 201},
		{"manager updates", me, http.MethodPut, "project_pbs_item/" + item.String(), map[string]any{"x": 3}, 200},
		{"admin updates", f.caller(uuid.New(), AdminGroup), http.MethodPut, "project_pbs_item/" + item.String(), map[string]any{"y": 4}, 200},
		{"manager deletes", me, http.MethodDelete, "project_pbs_item/" + item.String(), nil, 204},
	})
}

func TestPbs_Validation(t *testing.T) {
	f := newFixture(t)
	other := f.sibling()
	m := uuid.New()
	me := f.caller(m)
	p, q := f.project(m, "everyone"), f.project(m, "everyone")
	inQ := f.pbsItem(q, nil)
	a := f.pbsItem(p, nil)
	b := f.pbsItem(p, &a)
	path := "project_pbs_item/"
	body := func(extra map[string]any) map[string]any {
		b := map[string]any{"project_id": p}
		for k, v := range extra {
			b[k] = v
		}
		return b
	}
	f.run(t, []writeCase{
		{"missing name", me, http.MethodPost, "project_pbs_item", body(nil), 422},
		{"blank name", me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": "  "}), 422},
		{"name of 200", me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": strings.Repeat("n", 200)}), 201},
		{"name of 201", me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": strings.Repeat("n", 201)}), 422},
		{"description of 2000", me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": "D", "description": strings.Repeat("d", 2000)}), 201},
		{"description of 2001", me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": "D", "description": strings.Repeat("d", 2001)}), 422},
		{"named color", me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": "D", "color": "red"}), 422},
		{"null color", me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": "D", "color": nil}), 201},
		{"another tenant's parent", me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": "D", "parent_id": other.pbsItem(other.project(uuid.New(), "everyone"), nil)}), 422},
		{"parent in another project", me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": "D", "parent_id": inQ}), 422},
		{"valid parent", me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": "D", "parent_id": a}), 201},
		{"parent cycle", me, http.MethodPut, path + a.String(), map[string]any{"parent_id": b}, 422},
		{"own parent", me, http.MethodPut, path + a.String(), map[string]any{"parent_id": a}, 422},
		{"project change", me, http.MethodPut, path + a.String(), map[string]any{"project_id": q}, 422},
	})

	t.Run("color stored lowercase", func(t *testing.T) {
		code, out := f.do(me, http.MethodPost, "project_pbs_item", body(map[string]any{"name": "D", "color": "#ABCDEF"}))
		if code != http.StatusCreated || out["color"] != "#abcdef" {
			t.Fatalf("%d %v, want 201 with #abcdef", code, out)
		}
	})
	t.Run("reads", func(t *testing.T) {
		if n := f.total(me, "project_pbs_item?filter[project_id]="+p.String()); n == 0 {
			t.Errorf("manager sees no item")
		}
	})
}

func TestPbs_TaskLink(t *testing.T) {
	f := newFixture(t)
	other := f.sibling()
	m, mem := uuid.New(), uuid.New()
	me, member := f.caller(m), f.caller(mem)
	p := f.project(m, "members")
	f.member(p, mem)
	foreignItem := other.pbsItem(other.project(uuid.New(), "everyone"), nil)
	item := f.pbsItem(p, nil)
	task := f.task(p, nil, nil)
	f.run(t, []writeCase{
		{"item of another tenant", me, http.MethodPut, "project_task/" + task.String(), map[string]any{"pbs_item_id": foreignItem}, 422},
		{"unknown item", me, http.MethodPut, "project_task/" + task.String(), map[string]any{"pbs_item_id": uuid.New()}, 422},
	})
	// Any task editor may set and clear the link, not only the manager.
	for _, tc := range []struct {
		name string
		who  auth.Identity
	}{
		{"the manager", me}, {"a member", member},
	} {
		t.Run(tc.name+" sets and clears the link", func(t *testing.T) {
			if code, body := f.do(tc.who, http.MethodPut, "project_task/"+task.String(), map[string]any{"pbs_item_id": item}); code != http.StatusOK {
				t.Fatalf("link: %d %v, want 200", code, body)
			}
			if code, body := f.do(tc.who, http.MethodPut, "project_task/"+task.String(), map[string]any{"pbs_item_id": nil}); code != http.StatusOK {
				t.Fatalf("clear: %d %v, want 200", code, body)
			}
			if got := f.str(`SELECT pbs_item_id FROM project_task WHERE id = $1`, task); got != "" {
				t.Errorf("pbs_item_id %s, want cleared", got)
			}
		})
	}
}

func TestPbs_Counts(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	item := f.pbsItem(p, nil)
	t1, t2 := f.task(p, nil, nil), f.task(p, nil, nil)
	done := f.stage(p, "Done")
	counts := func(wantTask, wantDone float64) {
		if n := f.float(`SELECT task_count FROM project_pbs_item WHERE id = $1`, item); n != wantTask {
			t.Errorf("task_count %v, want %v", n, wantTask)
		}
		if n := f.float(`SELECT done_count FROM project_pbs_item WHERE id = $1`, item); n != wantDone {
			t.Errorf("done_count %v, want %v", n, wantDone)
		}
	}
	// Link through the API (the write path), then close, relink and unlink.
	if code, body := f.do(m, http.MethodPut, "project_task/"+t1.String(), map[string]any{"pbs_item_id": item}); code != http.StatusOK {
		t.Fatalf("link t1: %d %v, want 200", code, body)
	}
	counts(1, 0)
	f.moveTo(t1, done)
	counts(1, 1)
	f.moveTo(t1, f.stage(p, "New"))
	counts(1, 0)
	if code, body := f.do(m, http.MethodPut, "project_task/"+t2.String(), map[string]any{"pbs_item_id": item}); code != http.StatusOK {
		t.Fatalf("link t2: %d %v, want 200", code, body)
	}
	counts(2, 0)
	if code, body := f.do(m, http.MethodPut, "project_task/"+t1.String(), map[string]any{"pbs_item_id": nil}); code != http.StatusOK {
		t.Fatalf("unlink t1: %d %v, want 200", code, body)
	}
	counts(1, 0)
	// A deleted task leaves the count: the generic delete is a soft one.
	if code, body := f.do(m, http.MethodDelete, "project_task/"+t2.String(), nil); code != http.StatusNoContent {
		t.Fatalf("delete t2: %d %v, want 204", code, body)
	}
	counts(0, 0)
}

func TestPbs_DeleteDetaches(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	root := f.pbsItem(p, nil)
	c1, c2 := f.pbsItem(p, &root), f.pbsItem(p, &root)
	t1, t2, t3 := f.task(p, nil, nil), f.task(p, nil, nil), f.task(p, nil, nil)
	for _, tsk := range []uuid.UUID{t1, t2, t3} {
		f.linkPbs(tsk, root)
	}
	// Forced failure: while the tenant's sentinel row exists, a test trigger RAISEs
	// on the task clear, so the delete's transaction must roll back whole.
	f.exec(`CREATE TABLE IF NOT EXISTS project_pbs_delete_fail (tenant_id uuid PRIMARY KEY)`)
	f.exec(`CREATE OR REPLACE FUNCTION project_pbs_delete_fail() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF EXISTS (SELECT 1 FROM project_pbs_delete_fail s WHERE s.tenant_id = OLD.tenant_id) THEN
				RAISE EXCEPTION 'pbs delete: forced failure (test)';
			END IF;
			RETURN NULL;
		END $$`)
	f.exec(`DROP TRIGGER IF EXISTS trg_project_pbs_delete_fail ON project_task`)
	f.exec(`CREATE TRIGGER trg_project_pbs_delete_fail AFTER UPDATE OF pbs_item_id ON project_task
		FOR EACH ROW EXECUTE FUNCTION project_pbs_delete_fail()`)
	f.t.Cleanup(func() {
		f.exec(`DROP TRIGGER IF EXISTS trg_project_pbs_delete_fail ON project_task`)
		f.exec(`DELETE FROM project_pbs_delete_fail WHERE tenant_id = $1`, f.tenant)
	})
	f.exec(`INSERT INTO project_pbs_delete_fail VALUES ($1) ON CONFLICT DO NOTHING`, f.tenant)

	if code, body := f.do(m, http.MethodDelete, "project_pbs_item/"+root.String(), nil); code/100 != 5 {
		t.Fatalf("forced failure: %d %v, want 5xx", code, body)
	}
	if got := f.str(`SELECT deleted_at IS NOT NULL FROM project_pbs_item WHERE id = $1`, root); got != "false" {
		t.Errorf("the item was deleted despite the failure")
	}
	for _, c := range []uuid.UUID{c1, c2} {
		if got := f.str(`SELECT parent_id FROM project_pbs_item WHERE id = $1`, c); got != root.String() {
			t.Errorf("child %v parent %s, want %v", c, got, root)
		}
	}
	if n := f.float(`SELECT count(*) FROM project_task WHERE pbs_item_id = $1 AND deleted_at IS NULL`, root); n != 3 {
		t.Errorf("%v tasks still linked after the rollback, want 3", n)
	}

	f.exec(`DELETE FROM project_pbs_delete_fail WHERE tenant_id = $1`, f.tenant)
	if code, body := f.do(m, http.MethodDelete, "project_pbs_item/"+root.String(), nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d %v, want 204", code, body)
	}
	for _, c := range []uuid.UUID{c1, c2} {
		if got := f.str(`SELECT parent_id FROM project_pbs_item WHERE id = $1 AND deleted_at IS NULL`, c); got != "" {
			t.Errorf("child %v still has parent %v", c, got)
		}
	}
	if got := f.str(`SELECT deleted_at IS NOT NULL FROM project_pbs_item WHERE id = $1`, root); got != "true" {
		t.Errorf("item not deleted")
	}
	if n := f.float(`SELECT count(*) FROM project_task WHERE pbs_item_id = $1 AND deleted_at IS NULL`, root); n != 0 {
		t.Errorf("%v tasks still linked to the deleted item", n)
	}
}

func TestPbs_TaskMoveClearsItem(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p, q := f.project(m.UserID, "everyone"), f.project(m.UserID, "everyone")
	item := f.pbsItem(p, nil)
	root := f.task(p, nil, nil)
	child := f.task(p, &root, nil)
	f.linkPbs(root, item)
	f.linkPbs(child, item)
	if code, body := f.do(m, http.MethodPut, "project_task/"+root.String(), map[string]any{"project_id": q}); code != http.StatusOK {
		t.Fatalf("move: %d %v, want 200", code, body)
	}
	for _, tsk := range []uuid.UUID{root, child} {
		if got := f.str(`SELECT pbs_item_id FROM project_task WHERE id = $1`, tsk); got != "" {
			t.Errorf("task %v pbs_item_id %s, want cleared", tsk, got)
		}
	}
	if n := f.float(`SELECT task_count FROM project_pbs_item WHERE id = $1`, item); n != 0 {
		t.Errorf("task_count %v, want 0", n)
	}
}

func TestPbs_RestoreWithProject(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "members")
	item := f.pbsItem(p, nil)
	f.pbsItem(p, &item)
	if code, body := f.do(m, http.MethodDelete, "project/"+p.String(), nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d %v", code, body)
	}
	if n := f.float(`SELECT count(*) FROM project_pbs_item WHERE project_id = $1 AND deleted_at IS NULL`, p); n != 0 {
		t.Errorf("the PBS items outlived their project")
	}
	code, body := f.do(m, http.MethodPost, "project/"+p.String()+"/restore", nil)
	if code != http.StatusOK || body["id"] != p.String() {
		t.Fatalf("restore: %d %v, want 200 with the project", code, body)
	}
	if n := f.float(`SELECT count(*) FROM project_pbs_item WHERE project_id = $1 AND deleted_at IS NULL`, p); n != 2 {
		t.Errorf("the PBS items did not come back with their project")
	}
}

func TestPbs_Visibility(t *testing.T) {
	f := newFixture(t)
	m, mem := uuid.New(), uuid.New()
	me, member := f.caller(m), f.caller(mem)
	p := f.project(m, "members")
	f.member(p, mem)
	item := f.pbsItem(p, nil)
	stranger := f.caller(uuid.New())
	if n := f.total(stranger, "project_pbs_item?filter[project_id]="+p.String()); n != 0 {
		t.Errorf("stranger sees %d items, want 0", n)
	}
	if n := f.total(stranger, "project_pbs_item?in[id]="+item.String()); n != 0 {
		t.Errorf("stranger sees %d items through in[id], want 0", n)
	}
	if code, _ := f.get(stranger, "project_pbs_item/"+item.String()); code != http.StatusNotFound {
		t.Errorf("stranger get: %d, want 404", code)
	}
	if n := f.total(member, "project_pbs_item?filter[project_id]="+p.String()); n != 1 {
		t.Errorf("member sees %d items, want 1", n)
	}
	if code, _ := f.get(me, "project_pbs_item/"+item.String()); code != http.StatusOK {
		t.Errorf("manager get: %d, want 200", code)
	}
}
