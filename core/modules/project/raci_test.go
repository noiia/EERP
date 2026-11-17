package project

import (
	"net/http"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
)

// oneAccountable fails t unless the write answered 422 with code ONE_ACCOUNTABLE.
func (f *fixture) oneAccountable(t *testing.T, who auth.Identity, method, path string, body any) {
	t.Helper()
	code, out := f.do(who, method, path, body)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("%s %s: %d %v, want 422 ONE_ACCOUNTABLE", method, path, code, out)
	}
	if e, _ := out["error"].(map[string]any); e["code"] != "ONE_ACCOUNTABLE" {
		t.Fatalf("422 body %v, want code ONE_ACCOUNTABLE", out)
	}
}

// A task has at most one accountable: a second A is a 422 ONE_ACCOUNTABLE, on
// a create and on an update that turns an existing role into A.
func TestRaci_OneAccountable(t *testing.T) {
	f := newFixture(t)
	m := uuid.New()
	alice, bob := f.user(""), f.user("")
	me := f.caller(m)
	p := f.project(m, "everyone")
	task := f.task(p, nil, nil)

	code, body := f.do(me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": alice, "role": "A"})
	if code != http.StatusCreated || body["role"] != "A" {
		t.Fatalf("first accountable: %d %v, want 201", code, body)
	}
	f.oneAccountable(t, me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": bob, "role": "A"})

	code, body = f.do(me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": bob, "role": "R"})
	if code != http.StatusCreated {
		t.Fatalf("bob responder: %d %v, want 201", code, body)
	}
	f.oneAccountable(t, me, http.MethodPut, "project_task_raci/"+body["id"].(string), map[string]any{"role": "A"})
}

// A user holds one role per task: the unique live (task_id, user_id) is a 409,
// on a create, on an update that retargets the row, and it frees the pair once
// the row is deleted.
func TestRaci_OneRolePerUser(t *testing.T) {
	f := newFixture(t)
	m := uuid.New()
	alice, bob := f.user(""), f.user("")
	me := f.caller(m)
	p := f.project(m, "everyone")
	task := f.task(p, nil, nil)

	code, body := f.do(me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": alice, "role": "R"})
	if code != http.StatusCreated {
		t.Fatalf("alice row: %d %v, want 201", code, body)
	}
	aliceRow := body["id"].(string)
	f.run(t, []writeCase{
		{"same user, second role", me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": alice, "role": "C"}, 409},
	})
	code, body = f.do(me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": bob, "role": "C"})
	if code != http.StatusCreated {
		t.Fatalf("bob row: %d %v, want 201", code, body)
	}
	f.run(t, []writeCase{
		{"retarget the row to bob", me, http.MethodPut, "project_task_raci/" + aliceRow, map[string]any{"user_id": bob}, 409},
		{"delete alice's row", me, http.MethodDelete, "project_task_raci/" + aliceRow, nil, 204},
	})
	code, body = f.do(me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": alice, "role": "C"})
	if code != http.StatusCreated {
		t.Fatalf("pair free after the delete: %d %v, want 201", code, body)
	}
}

// Only staff users (not website visitors) hold a role.
func TestRaci_StaffOnly(t *testing.T) {
	f := newFixture(t)
	me := f.caller(uuid.New())
	p := f.project(me.UserID, "everyone")
	task := f.task(p, nil, nil)
	staff, visitor := f.user(""), f.user("website")

	code, body := f.do(me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": staff, "role": "R"})
	if code != http.StatusCreated {
		t.Fatalf("staff row: %d %v, want 201", code, body)
	}
	staffRow := body["id"].(string)
	f.run(t, []writeCase{
		{"website user", me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": visitor, "role": "R"}, 422},
		{"unknown user", me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": uuid.New(), "role": "R"}, 422},
		{"edit to a website user", me, http.MethodPut, "project_task_raci/" + staffRow, map[string]any{"user_id": visitor}, 422},
	})
}

// The row's project is always the task's, whatever the client sent.
func TestRaci_ProjectIdFromTask(t *testing.T) {
	f := newFixture(t)
	m := uuid.New()
	alice := f.user("")
	me := f.caller(m)
	p, q := f.project(m, "everyone"), f.project(m, "everyone")
	task := f.task(p, nil, nil)

	code, body := f.do(me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": alice, "role": "R", "project_id": q})
	if code != http.StatusCreated || body["project_id"] != p.String() {
		t.Fatalf("%d %v, want 201 in the task's project %s", code, body, p)
	}
	if n := f.total(me, "project_task_raci?filter[task_id]="+task.String()); n != 1 {
		t.Errorf("list by task: total %d, want 1", n)
	}
}

// A task move carries its RACI rows to the target project.
func TestRaci_FollowsTaskMove(t *testing.T) {
	f := newFixture(t)
	m := uuid.New()
	alice, bob := f.user(""), f.user("")
	me := f.caller(m)
	p, q := f.project(m, "everyone"), f.project(m, "everyone")
	task := f.task(p, nil, nil)
	for _, c := range []struct {
		user uuid.UUID
		role string
	}{{alice, "A"}, {bob, "R"}} {
		code, body := f.do(me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": c.user, "role": c.role})
		if code != http.StatusCreated {
			t.Fatalf("seed %s: %d %v, want 201", c.role, code, body)
		}
	}
	if code, body := f.do(me, http.MethodPut, "project_task/"+task.String(), map[string]any{"project_id": q}); code != http.StatusOK {
		t.Fatalf("move: %d %v, want 200", code, body)
	}
	n := f.str(`SELECT count(*)::text FROM project_task_raci WHERE task_id = $1 AND project_id = $2`, task, q)
	if n != "2" {
		t.Errorf("rows in the target project: %s, want 2", n)
	}
}

// A deleted task's RACI rows are hidden, like its assignees.
func TestRaci_HiddenWithDeletedTask(t *testing.T) {
	f := newFixture(t)
	m := uuid.New()
	alice := f.user("")
	me := f.caller(m)
	p := f.project(m, "everyone")
	task := f.task(p, nil, nil)

	code, body := f.do(me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": alice, "role": "A"})
	if code != http.StatusCreated {
		t.Fatalf("row: %d %v, want 201", code, body)
	}
	row := body["id"].(string)
	if code, _ := f.do(me, http.MethodDelete, "project_task/"+task.String(), nil); code != http.StatusNoContent {
		t.Fatalf("delete the task: %d, want 204", code)
	}
	if n := f.total(me, "project_task_raci"); n != 0 {
		t.Errorf("after the delete: total %d, want 0", n)
	}
	if code, _ := f.get(me, "project_task_raci/"+row); code != http.StatusNotFound {
		t.Errorf("GET the row: %d, want 404", code)
	}
}

// A members-only project's RACI rows are hidden from a non-member: the list
// is empty, the row is a 404 and a write on the hidden task is a 422.
func TestRaci_HiddenWithTask(t *testing.T) {
	f := newFixture(t)
	m, out := uuid.New(), uuid.New()
	alice := f.user("")
	me := f.caller(m)
	p := f.project(m, "members")
	task := f.task(p, nil, nil)

	code, body := f.do(me, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": alice, "role": "A"})
	if code != http.StatusCreated {
		t.Fatalf("manager row: %d %v, want 201", code, body)
	}
	row := body["id"].(string)
	who := f.caller(out)
	if n := f.total(who, "project_task_raci"); n != 0 {
		t.Errorf("outsider: total %d, want 0", n)
	}
	if code, _ := f.get(who, "project_task_raci/"+row); code != http.StatusNotFound {
		t.Errorf("GET the row: %d, want 404", code)
	}
	if code, _ := f.do(who, http.MethodPost, "project_task_raci", map[string]any{"task_id": task, "user_id": alice, "role": "R"}); code != http.StatusUnprocessableEntity {
		t.Errorf("POST on the hidden task: %d, want 422", code)
	}
	if n := f.total(me, "project_task_raci"); n != 1 {
		t.Errorf("manager: total %d, want 1", n)
	}
}

// hours_per_week stays in (0, 168].
func TestCapacity_Range(t *testing.T) {
	f := newFixture(t)
	me := f.caller(uuid.New())
	user := f.user("")
	f.run(t, []writeCase{
		{"zero hours", me, http.MethodPost, "project_capacity", map[string]any{"user_id": user, "hours_per_week": 0}, 422},
		{"169 hours", me, http.MethodPost, "project_capacity", map[string]any{"user_id": user, "hours_per_week": 169}, 422},
		{"not a number", me, http.MethodPost, "project_capacity", map[string]any{"user_id": user, "hours_per_week": "forty"}, 422},
	})
	code, body := f.do(me, http.MethodPost, "project_capacity", map[string]any{"user_id": user, "hours_per_week": 168})
	if code != http.StatusCreated || body["hours_per_week"] != float64(168) {
		t.Fatalf("boundary 168: %d %v, want 201 with hours_per_week 168", code, body)
	}
	row := body["id"].(string)
	f.run(t, []writeCase{
		{"edit to 169", me, http.MethodPut, "project_capacity/" + row, map[string]any{"hours_per_week": 169}, 422},
		{"edit to zero", me, http.MethodPut, "project_capacity/" + row, map[string]any{"hours_per_week": 0}, 422},
		{"edit to 10", me, http.MethodPut, "project_capacity/" + row, map[string]any{"hours_per_week": 10}, 200},
	})
}

// One live capacity row per (tenant, user): a second is a 409.
func TestCapacity_Unique(t *testing.T) {
	f := newFixture(t)
	me := f.caller(uuid.New())
	alice, bob := f.user(""), f.user("")
	f.run(t, []writeCase{
		{"first row", me, http.MethodPost, "project_capacity", map[string]any{"user_id": alice, "hours_per_week": 40}, 201},
		{"second row for the same user", me, http.MethodPost, "project_capacity", map[string]any{"user_id": alice, "hours_per_week": 30}, 409},
		{"another user", me, http.MethodPost, "project_capacity", map[string]any{"user_id": bob, "hours_per_week": 30}, 201},
		{"unknown user", me, http.MethodPost, "project_capacity", map[string]any{"user_id": uuid.New(), "hours_per_week": 30}, 422},
	})
}
