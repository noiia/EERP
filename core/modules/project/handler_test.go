package project

import (
	"net/http"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
)

func TestDeleteProject_RefusedWithTasks(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	task := f.task(p, nil, nil)
	f.milestone(p)
	f.member(p, uuid.New())

	code, body := f.do(m, http.MethodDelete, "project/"+p.String(), nil)
	if e, _ := body["error"].(map[string]any); code != http.StatusConflict || e["code"] != "CONFLICT" {
		t.Fatalf("with a task: %d %v, want 409 CONFLICT", code, body)
	}
	f.exec(`UPDATE project_task SET deleted_at = now() WHERE id = $1`, task)
	if code, body := f.do(m, http.MethodDelete, "project/"+p.String(), nil); code != http.StatusNoContent {
		t.Fatalf("empty: %d %v, want 204", code, body)
	}
	for _, table := range []string{"project_stage", "project_milestone", "project_member"} {
		if n := f.float(`SELECT count(*) FROM `+table+` WHERE project_id = $1 AND deleted_at IS NULL`, p); n != 0 {
			t.Errorf("%s: %v live rows left", table, n)
		}
	}
	if code, _ := f.do(m, http.MethodGet, "project/"+p.String(), nil); code != http.StatusNotFound {
		t.Errorf("deleted project: %d, want 404", code)
	}
}

func TestDeleteStage_RefusedWithTasks(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	task := f.task(p, nil, nil) // in "New"
	stage := f.stage(p, "New")
	if code, body := f.do(m, http.MethodDelete, "project_stage/"+stage.String(), nil); code != http.StatusConflict {
		t.Fatalf("with a task: %d %v, want 409", code, body)
	}
	f.moveTo(task, f.stage(p, "Done"))
	if code, body := f.do(m, http.MethodDelete, "project_stage/"+stage.String(), nil); code != http.StatusNoContent {
		t.Fatalf("empty: %d %v, want 204", code, body)
	}
}

func TestUpdateTask_MoveCascades(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p, q := f.project(m.UserID, "everyone"), f.project(m.UserID, "everyone")
	f.exec(`UPDATE project_stage SET name = 'Doing' WHERE project_id = $1 AND name = 'In progress'`, q)
	milestone := f.milestone(p)
	root := f.task(p, nil, &milestone)
	f.moveTo(root, f.stage(p, "In progress")) // no such name in q: falls back to q's first stage
	child := f.task(p, &root, &milestone)
	f.moveTo(child, f.stage(p, "Done"))
	grandchild := f.task(p, &child, nil)
	f.timesheet(p, child, 2)
	f.timesheet(p, grandchild, 3)
	f.assign(p, grandchild, m.UserID)
	other := f.task(p, nil, nil)
	f.dependency(p, grandchild, other)
	f.exec(`INSERT INTO project_task_color (tenant_id, project_id, task_id, color_id) VALUES ($1, $2, $3, $4)`, f.tenant, p, child, f.color())

	code, body := f.do(m, http.MethodPut, "project_task/"+root.String(), map[string]any{"project_id": q, "name": "Moved", "milestone_id": milestone})
	if code != http.StatusOK || body["name"] != "Moved" || body["project_id"] != q.String() {
		t.Fatalf("move: %d %v, want 200 in q renamed", code, body)
	}
	for task, stage := range map[uuid.UUID]string{root: "New", child: "Done", grandchild: "New"} {
		if got := f.str(`SELECT project_id FROM project_task WHERE id = $1`, task); got != q.String() {
			t.Errorf("task %s: project %s, want q", task, got)
		}
		if got := f.str(`SELECT s.name FROM project_task t JOIN project_stage s ON s.id = t.stage_id
			WHERE t.id = $1 AND s.project_id = $2`, task, q); got != stage {
			t.Errorf("task %s: stage %q, want q's %q", task, got, stage)
		}
		if got := f.str(`SELECT milestone_id FROM project_task WHERE id = $1`, task); got != "" {
			t.Errorf("task %s: milestone %s, want cleared", task, got)
		}
	}
	for _, table := range []string{"project_timesheet", "project_task_user", "project_task_dependency", "project_task_color"} {
		if n := f.float(`SELECT count(*) FROM `+table+` WHERE project_id = $1`, p); n != 0 {
			t.Errorf("%s: %v rows left in p", table, n)
		}
	}
	if got := f.float(`SELECT spent_hours FROM project WHERE id = $1`, q); got != 5 {
		t.Errorf("q spent %v, want 5", got)
	}
	if got := f.float(`SELECT spent_hours FROM project WHERE id = $1`, p); got != 0 {
		t.Errorf("p spent %v, want 0", got)
	}
	if got := f.float(`SELECT task_count FROM project_milestone WHERE id = $1`, milestone); got != 0 {
		t.Errorf("milestone task_count %v, want 0", got)
	}

	t.Run("only the project", func(t *testing.T) {
		code, body := f.do(m, http.MethodPut, "project_task/"+root.String(), map[string]any{"project_id": p})
		if code != http.StatusOK || body["project_id"] != p.String() {
			t.Fatalf("move back: %d %v", code, body)
		}
	})
}

func TestUpdateTask_MoveSubtaskRefused(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p, q := f.project(m.UserID, "everyone"), f.project(m.UserID, "everyone")
	hidden := f.project(uuid.New(), "members")
	root := f.task(p, nil, nil)
	child := f.task(p, &root, nil)
	f.run(t, []writeCase{
		{"subtask", m, http.MethodPut, "project_task/" + child.String(), map[string]any{"project_id": q}, 422},
		{"to a hidden project", m, http.MethodPut, "project_task/" + root.String(), map[string]any{"project_id": hidden}, 422},
		{"subtask detached and moved", m, http.MethodPut, "project_task/" + child.String(), map[string]any{"project_id": q, "parent_id": nil}, 200},
	})
	if got := f.str(`SELECT parent_id FROM project_task WHERE id = $1`, child); got != "" {
		t.Errorf("detached subtask keeps parent %s", got)
	}
}

func TestCanManage(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	hidden := f.project(uuid.New(), "members")
	for _, tc := range []struct {
		name string
		who  auth.Identity
		id   uuid.UUID
		code int
		can  bool
	}{
		{"manager", m, p, 200, true},
		{"other user", f.caller(uuid.New()), p, 200, false},
		{"admin", f.caller(uuid.New(), AdminGroup), hidden, 200, true},
		{"hidden", f.caller(uuid.New()), hidden, 404, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, body := f.do(tc.who, http.MethodGet, "project/"+tc.id.String()+"/can_manage", nil)
			if code != tc.code || (code == 200 && body["can_manage"] != tc.can) {
				t.Errorf("%d %v, want %d can_manage=%v", code, body, tc.code, tc.can)
			}
		})
	}
}

func TestUpdateTask_AssigneeOnlyMoveRefused(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "members")
	q := f.project(uuid.New(), "everyone")
	root := f.task(p, nil, nil)
	child := f.task(p, &root, nil)
	f.timesheet(p, child, 2)
	a := f.caller(uuid.New())
	f.assign(p, root, a.UserID)

	if code, body := f.do(a, http.MethodPut, "project_task/"+root.String(), map[string]any{"project_id": q}); code != http.StatusNotFound {
		t.Fatalf("assignee-only move: %d %v, want 404", code, body)
	}
	for _, task := range []uuid.UUID{root, child} {
		if got := f.str(`SELECT project_id FROM project_task WHERE id = $1`, task); got != p.String() {
			t.Errorf("task %s moved to %s, want it kept in p", task, got)
		}
	}
	if n := f.float(`SELECT count(*) FROM project_timesheet WHERE project_id = $1`, q); n != 0 {
		t.Errorf("%v timesheets moved to q", n)
	}
	// An edit that doesn't move still works for the assignee.
	if code, body := f.do(a, http.MethodPut, "project_task/"+root.String(), map[string]any{"name": "Renamed"}); code != http.StatusOK {
		t.Errorf("assignee edit: %d %v, want 200", code, body)
	}
}

func TestRestoreProject(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "members")
	old := f.milestone(p) // deleted before the project: stays deleted
	f.exec(`UPDATE project_milestone SET deleted_at = now() - interval '1 day' WHERE id = $1`, old)
	f.milestone(p)
	member := f.caller(uuid.New())
	f.member(p, member.UserID)
	if code, body := f.do(m, http.MethodDelete, "project/"+p.String(), nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d %v", code, body)
	}

	f.run(t, []writeCase{
		{"stranger", f.caller(uuid.New()), http.MethodPost, "project/" + p.String() + "/restore", nil, 404},
		{"member, not manager", member, http.MethodPost, "project/" + p.String() + "/restore", nil, 403},
	})
	code, body := f.do(m, http.MethodPost, "project/"+p.String()+"/restore", nil)
	if code != http.StatusOK || body["id"] != p.String() {
		t.Fatalf("restore: %d %v, want 200 with the project", code, body)
	}
	for table, want := range map[string]float64{"project_stage": 3, "project_milestone": 1, "project_member": 1} {
		if n := f.float(`SELECT count(*) FROM `+table+` WHERE project_id = $1 AND deleted_at IS NULL`, p); n != want {
			t.Errorf("%s: %v live rows, want %v", table, n, want)
		}
	}
	if n := f.float(`SELECT count(*) FROM project_milestone WHERE id = $1 AND deleted_at IS NULL`, old); n != 0 {
		t.Errorf("a milestone deleted earlier came back")
	}
	if code, _ := f.do(m, http.MethodPost, "project/"+p.String()+"/restore", nil); code != http.StatusNotFound {
		t.Errorf("restore a live project: %d, want 404", code)
	}
}

func TestTaskChildScope_HidesDeletedTasksRows(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	live, gone := f.task(p, nil, nil), f.task(p, nil, nil)
	f.timesheet(p, live, 2)
	f.timesheet(p, gone, 3)
	f.exec(`UPDATE project_task SET deleted_at = now() WHERE id = $1`, gone)
	if n := f.total(m, "project_timesheet?filter[project_id]="+p.String()); n != 1 {
		t.Errorf("timesheets listed: %d, want 1 (the deleted task's hidden)", n)
	}
	if got := f.float(`SELECT spent_hours FROM project WHERE id = $1`, p); got != 2 {
		t.Errorf("spent_hours %v, want 2", got)
	}
}
