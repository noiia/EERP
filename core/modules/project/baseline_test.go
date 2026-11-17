package project

import (
	"net/http"
	"strings"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
)

func baselineID(t *testing.T, body map[string]any) uuid.UUID {
	t.Helper()
	s, _ := body["id"].(string)
	id, err := uuid.Parse(s)
	if err != nil {
		t.Fatalf("no id in %v", body)
	}
	return id
}

func TestBaseline_Snapshot(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	a := f.task(p, nil, nil)
	b := f.task(p, nil, nil)
	gone := f.task(p, nil, nil)
	f.exec(`UPDATE project_task SET date_start = '2026-01-05', deadline = '2026-01-09', planned_hours = 16 WHERE id = $1`, a)
	f.exec(`UPDATE project_task SET planned_hours = 8 WHERE id = $1`, b)
	f.exec(`UPDATE project_task SET deleted_at = now() WHERE id = $1`, gone)

	code, body := f.do(m, http.MethodPost, "project/"+p.String()+"/baseline", map[string]any{"name": "V1"})
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v, want 201", code, body)
	}
	if body["name"] != "V1" || body["project_id"] != p.String() || body["created_by"] != m.UserID.String() {
		t.Fatalf("answer %v, want the created baseline", body)
	}
	id := baselineID(t, body)
	// The snapshot copies every LIVE task's dates and planned hours, not the
	// deleted task's.
	if n := f.float(`SELECT count(*) FROM project_baseline_task WHERE baseline_id = $1 AND deleted_at IS NULL`, id); n != 2 {
		t.Fatalf("snapshot rows: %v, want 2 (the deleted task excluded)", n)
	}
	if n := f.float(`SELECT count(*) FROM project_baseline_task WHERE task_id = $1`, gone); n != 0 {
		t.Errorf("the deleted task was snapshotted")
	}
	if got := f.str(`SELECT date_start FROM project_baseline_task WHERE task_id = $1`, a); got != "2026-01-05 00:00:00+00" {
		t.Errorf("date_start %q, want the task's", got)
	}
	if got := f.str(`SELECT deadline FROM project_baseline_task WHERE task_id = $1`, a); got != "2026-01-09 00:00:00+00" {
		t.Errorf("deadline %q, want the task's", got)
	}
	if got := f.float(`SELECT planned_hours FROM project_baseline_task WHERE task_id = $1`, a); got != 16 {
		t.Errorf("planned_hours %v, want 16", got)
	}
	if got := f.str(`SELECT project_id FROM project_baseline_task WHERE task_id = $1`, a); got != p.String() {
		t.Errorf("row project_id %s, want the baseline's project", got)
	}
	// The snapshot is frozen: a later task edit does not reach it.
	if code, _ := f.do(m, http.MethodPut, "project_task/"+a.String(), map[string]any{"planned_hours": 40}); code != http.StatusOK {
		t.Fatalf("task edit: %d, want 200", code)
	}
	if got := f.float(`SELECT planned_hours FROM project_baseline_task WHERE task_id = $1`, a); got != 16 {
		t.Errorf("after a task edit: planned_hours %v, want 16 (frozen)", got)
	}
}

func TestBaseline_ManagerOnly(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	stranger := f.caller(uuid.New())
	member := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	f.member(p, member.UserID)
	hidden := f.project(m.UserID, "members")
	long := strings.Repeat("x", 201)

	f.run(t, []writeCase{
		{"stranger creates", stranger, http.MethodPost, "project/" + p.String() + "/baseline", map[string]any{"name": "B"}, 403},
		{"member creates", member, http.MethodPost, "project/" + p.String() + "/baseline", map[string]any{"name": "B"}, 403},
		{"hidden project", stranger, http.MethodPost, "project/" + hidden.String() + "/baseline", map[string]any{"name": "B"}, 404},
		{"empty name", m, http.MethodPost, "project/" + p.String() + "/baseline", map[string]any{"name": "  "}, 422},
		{"name over 200", m, http.MethodPost, "project/" + p.String() + "/baseline", map[string]any{"name": long}, 422},
	})
	code, body := f.do(m, http.MethodPost, "project/"+p.String()+"/baseline", map[string]any{"name": "B"})
	if code != http.StatusCreated {
		t.Fatalf("manager create: %d %v, want 201", code, body)
	}
	id := baselineID(t, body)
	f.run(t, []writeCase{
		{"stranger deletes", stranger, http.MethodDelete, "project_baseline/" + id.String(), nil, 403},
		{"member deletes", member, http.MethodDelete, "project_baseline/" + id.String(), nil, 403},
		{"generic create refused", m, http.MethodPost, "project_baseline", map[string]any{"name": "B", "project_id": p}, 403},
	})
	if code, _ := f.do(m, http.MethodDelete, "project_baseline/"+id.String(), nil); code != http.StatusNoContent {
		t.Fatalf("manager delete: %d, want 204", code)
	}
	// A deleted baseline's restore is the manager's (or an admin's) too.
	f.run(t, []writeCase{
		{"stranger restores", stranger, http.MethodPost, "project_baseline/" + id.String() + "/restore", nil, 403},
		{"member restores", member, http.MethodPost, "project_baseline/" + id.String() + "/restore", nil, 403},
	})
	// An admin may create and delete too.
	admin := f.caller(uuid.New(), AdminGroup)
	code, body = f.do(admin, http.MethodPost, "project/"+p.String()+"/baseline", map[string]any{"name": "B2"})
	if code != http.StatusCreated {
		t.Fatalf("admin create: %d %v, want 201", code, body)
	}
	if code, _ := f.do(admin, http.MethodDelete, "project_baseline/"+baselineID(t, body).String(), nil); code != http.StatusNoContent {
		t.Fatalf("admin delete: %d, want 204", code)
	}
	// A plain rename stays open to any writer of a visible project.
	code, body = f.do(m, http.MethodPost, "project/"+p.String()+"/baseline", map[string]any{"name": "B3"})
	if code != http.StatusCreated {
		t.Fatalf("create for a rename: %d %v", code, body)
	}
	renameID := baselineID(t, body)
	if code, body := f.do(stranger, http.MethodPut, "project_baseline/"+renameID.String(), map[string]any{"name": "B3 renamed"}); code != http.StatusOK || body["name"] != "B3 renamed" {
		t.Fatalf("rename: %d %v, want 200", code, body)
	}
	if code, _ := f.do(stranger, http.MethodPut, "project_baseline/"+renameID.String(), map[string]any{"name": long}); code != http.StatusUnprocessableEntity {
		t.Fatalf("rename over 200: %d, want 422", code)
	}
}

func TestBaseline_Limit20(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	var ids []uuid.UUID
	for i := 0; i < 20; i++ {
		code, body := f.do(m, http.MethodPost, "project/"+p.String()+"/baseline", map[string]any{"name": "B" + string(rune('A'+i))})
		if code != http.StatusCreated {
			t.Fatalf("baseline %d: %d %v, want 201", i, code, body)
		}
		ids = append(ids, baselineID(t, body))
	}
	code, body := f.do(m, http.MethodPost, "project/"+p.String()+"/baseline", map[string]any{"name": "B20"})
	if e, _ := body["error"].(map[string]any); code != http.StatusConflict || e["code"] != "BASELINE_LIMIT" {
		t.Fatalf("21st: %d %v, want 409 BASELINE_LIMIT", code, body)
	}
	// A deleted slot frees a place.
	if code, _ := f.do(m, http.MethodDelete, "project_baseline/"+ids[0].String(), nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d, want 204", code)
	}
	if code, body := f.do(m, http.MethodPost, "project/"+p.String()+"/baseline", map[string]any{"name": "B20"}); code != http.StatusCreated {
		t.Fatalf("after a delete: %d %v, want 201", code, body)
	}
	// The limit is per project: another project starts at 0.
	q := f.project(m.UserID, "everyone")
	if code, body := f.do(m, http.MethodPost, "project/"+q.String()+"/baseline", map[string]any{"name": "Q1"}); code != http.StatusCreated {
		t.Fatalf("other project: %d %v, want 201", code, body)
	}
}

func TestBaseline_TaskRowsReadOnly(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	t1 := f.task(p, nil, nil)
	code, body := f.do(m, http.MethodPost, "project/"+p.String()+"/baseline", map[string]any{"name": "B"})
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v, want 201", code, body)
	}
	id := baselineID(t, body)
	rowID := f.id(`SELECT id FROM project_baseline_task WHERE baseline_id = $1 AND task_id = $2`, id, t1)

	f.run(t, []writeCase{
		{"create", m, http.MethodPost, "project_baseline_task", map[string]any{"baseline_id": id, "project_id": p, "task_id": t1, "planned_hours": 1}, 403},
		{"update", m, http.MethodPut, "project_baseline_task/" + rowID.String(), map[string]any{"planned_hours": 99}, 403},
		{"delete", m, http.MethodDelete, "project_baseline_task/" + rowID.String(), nil, 403},
	})
	// The refused writes touched nothing: the row is live and unchanged.
	if n := f.float(`SELECT count(*) FROM project_baseline_task WHERE baseline_id = $1 AND deleted_at IS NULL`, id); n != 1 {
		t.Errorf("rows: %v, want 1", n)
	}
	if got := f.float(`SELECT planned_hours FROM project_baseline_task WHERE id = $1`, rowID); got != 0 {
		t.Errorf("planned_hours %v, want 0 (untouched)", got)
	}
	// The read surface stays open.
	if code, _ := f.get(m, "project_baseline_task"); code != http.StatusOK {
		t.Errorf("list: %d, want 200", code)
	}
	if code, _ := f.get(m, "project_baseline_task/"+rowID.String()); code != http.StatusOK {
		t.Errorf("get: %d, want 200", code)
	}
	// A restore of a deleted row (its baseline gone) is refused too.
	if code, _ := f.do(m, http.MethodDelete, "project_baseline/"+id.String(), nil); code != http.StatusNoContent {
		t.Fatalf("baseline delete: %d, want 204", code)
	}
	if code, body := f.do(m, http.MethodPost, "project_baseline_task/"+rowID.String()+"/restore", nil); code != http.StatusForbidden {
		t.Errorf("restore a deleted row: %d %v, want 403", code, body)
	}
	if n := f.float(`SELECT count(*) FROM project_baseline_task WHERE id = $1 AND deleted_at IS NULL`, rowID); n != 0 {
		t.Errorf("the deleted row came back")
	}
}

func TestBaseline_DeleteCascades(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	t1, t2 := f.task(p, nil, nil), f.task(p, nil, nil)
	f.exec(`UPDATE project_task SET planned_hours = 8 WHERE id = $1`, t1)
	f.exec(`UPDATE project_task SET planned_hours = 16 WHERE id = $1`, t2)
	code, body := f.do(m, http.MethodPost, "project/"+p.String()+"/baseline", map[string]any{"name": "B"})
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v, want 201", code, body)
	}
	id := baselineID(t, body)

	if code, body := f.do(m, http.MethodDelete, "project_baseline/"+id.String(), nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d %v, want 204", code, body)
	}
	if n := f.float(`SELECT count(*) FROM project_baseline WHERE id = $1 AND deleted_at IS NULL`, id); n != 0 {
		t.Errorf("the baseline outlived its delete")
	}
	if n := f.float(`SELECT count(*) FROM project_baseline_task WHERE baseline_id = $1 AND deleted_at IS NULL`, id); n != 0 {
		t.Errorf("%v task rows outlived their baseline", n)
	}
	// The snapshot's source is untouched.
	if n := f.float(`SELECT count(*) FROM project_task WHERE project_id = $1 AND deleted_at IS NULL`, p); n != 2 {
		t.Errorf("tasks: %v, want 2 (the delete touched the snapshot only)", n)
	}
	// The rows come back with the baseline (the DeleteColor shape): delete and
	// restore twice, the rows follow both times.
	for round := 1; round <= 2; round++ {
		code, body := f.do(m, http.MethodPost, "project_baseline/"+id.String()+"/restore", nil)
		if code != http.StatusOK || body["id"] != id.String() {
			t.Fatalf("restore %d: %d %v, want 200 with the baseline", round, code, body)
		}
		if n := f.float(`SELECT count(*) FROM project_baseline_task WHERE baseline_id = $1 AND deleted_at IS NULL`, id); n != 2 {
			t.Fatalf("rows after restore %d: %v, want 2", round, n)
		}
		if code, _ := f.do(m, http.MethodDelete, "project_baseline/"+id.String(), nil); code != http.StatusNoContent {
			t.Fatalf("delete %d: %d, want 204", round, code)
		}
	}
	// Bring it back once more, then restore a LIVE baseline: 404.
	if code, _ := f.do(m, http.MethodPost, "project_baseline/"+id.String()+"/restore", nil); code != http.StatusOK {
		t.Fatalf("final restore: %d, want 200", code)
	}
	if code, _ := f.do(m, http.MethodPost, "project_baseline/"+id.String()+"/restore", nil); code != http.StatusNotFound {
		t.Errorf("restore a live baseline: %d, want 404", code)
	}
}

func TestBaseline_Visibility(t *testing.T) {
	f := newFixture(t)
	manager, member, outsider := uuid.New(), uuid.New(), uuid.New()
	p := f.project(manager, "members")
	f.member(p, member)
	t1 := f.task(p, nil, nil)
	f.exec(`UPDATE project_task SET planned_hours = 8 WHERE id = $1`, t1)
	code, body := f.do(f.caller(manager), http.MethodPost, "project/"+p.String()+"/baseline", map[string]any{"name": "B"})
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v, want 201", code, body)
	}
	id := baselineID(t, body)
	rowID := f.id(`SELECT id FROM project_baseline_task WHERE baseline_id = $1`, id)

	// The rows carry the project's visibility: an outsider sees neither the
	// baseline nor its snapshot rows.
	out := f.caller(outsider)
	if n := f.total(out, "project_baseline"); n != 0 {
		t.Errorf("baselines listed: %d, want 0", n)
	}
	if n := f.total(out, "project_baseline_task"); n != 0 {
		t.Errorf("task rows listed: %d, want 0", n)
	}
	if code, _ := f.get(out, "project_baseline/"+id.String()); code != http.StatusNotFound {
		t.Errorf("GET baseline: %d, want 404", code)
	}
	if code, _ := f.get(out, "project_baseline_task/"+rowID.String()); code != http.StatusNotFound {
		t.Errorf("GET task row: %d, want 404", code)
	}
	for name, who := range map[string]auth.Identity{
		"manager": f.caller(manager),
		"member":  f.caller(member),
		"admin":   f.caller(uuid.New(), AdminGroup),
	} {
		t.Run(name+" sees the baseline", func(t *testing.T) {
			if n := f.total(who, "project_baseline"); n != 1 {
				t.Errorf("baselines: %d, want 1", n)
			}
			if n := f.total(who, "project_baseline_task"); n != 1 {
				t.Errorf("task rows: %d, want 1", n)
			}
			if code, _ := f.get(who, "project_baseline/"+id.String()); code != http.StatusOK {
				t.Errorf("GET baseline: %d, want 200", code)
			}
		})
	}
}
