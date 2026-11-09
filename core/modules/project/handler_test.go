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
	for _, table := range []string{"project_timesheet", "project_task_user", "project_task_dependency"} {
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
