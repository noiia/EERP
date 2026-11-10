package project

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/auth"
	"core/orm/access"

	"github.com/google/uuid"
)

// do serves a request as who; body is JSON-encoded unless nil.
func (f *fixture) do(who auth.Identity, method, path string, body any) (int, map[string]any) {
	f.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	ctx := auth.SetIdentity(context.Background(), who)
	ctx = access.WithTenant(ctx, who.TenantID)
	ctx = access.WithGroups(ctx, who.Groups)
	req := httptest.NewRequest(method, "/api/v1/"+path, &buf).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.e.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// sibling is a second tenant on the same database (its rows are cleaned up too).
func (f *fixture) sibling() *fixture {
	g := *f
	g.tenant = uuid.New()
	f.t.Cleanup(func() {
		for _, table := range projectTables {
			_, _ = f.app.DB.Exec(context.Background(), `DELETE FROM `+table+` WHERE tenant_id = $1`, g.tenant)
		}
	})
	return &g
}

func (f *fixture) str(sql string, args ...any) string {
	f.t.Helper()
	var s *string
	if err := f.app.DB.QueryRow(context.Background(), `SELECT (`+sql+`)::text`, args...).Scan(&s); err != nil {
		f.t.Fatalf("query %q: %v", sql, err)
	}
	if s == nil {
		return ""
	}
	return *s
}

func (f *fixture) tag() uuid.UUID {
	return f.id(`INSERT INTO project_tag (tenant_id, name) VALUES ($1, 'tag') RETURNING id`, f.tenant)
}

func (f *fixture) color() uuid.UUID {
	return f.id(`INSERT INTO project_color (tenant_id, name, color) VALUES ($1, 'c', '#123abc') RETURNING id`, f.tenant)
}

type writeCase struct {
	name   string
	who    auth.Identity
	method string
	path   string
	body   map[string]any
	want   int
}

func (f *fixture) run(t *testing.T, cases []writeCase) {
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, body := f.do(tc.who, tc.method, tc.path, tc.body)
			if code != tc.want {
				t.Errorf("%s %s: %d, want %d: %v", tc.method, tc.path, code, tc.want, body)
			}
			if code == http.StatusUnprocessableEntity {
				if e, _ := body["error"].(map[string]any); e["code"] != "VALIDATION_ERROR" {
					t.Errorf("422 body %v, want code VALIDATION_ERROR", body)
				}
			}
		})
	}
}

func TestValidate_References(t *testing.T) {
	f := newFixture(t)
	other := f.sibling()
	m, stranger := uuid.New(), uuid.New()
	me := f.caller(m)
	p, q := f.project(m, "everyone"), f.project(m, "everyone")
	hidden := f.project(stranger, "members")
	foreign := other.project(m, "everyone")
	foreignTask := other.task(foreign, nil, nil)
	hiddenTask := f.task(hidden, nil, nil)
	pTask, qTask := f.task(p, nil, nil), f.task(q, nil, nil)
	child := f.task(p, &pTask, nil)
	a, b := f.task(p, nil, nil), f.task(p, nil, nil)
	f.dependency(p, a, b)
	foreignTag := other.tag()

	task := func(extra map[string]any) map[string]any {
		body := map[string]any{"project_id": p, "name": "T"}
		for k, v := range extra {
			body[k] = v
		}
		return body
	}
	f.run(t, []writeCase{
		{"task in a hidden project", me, http.MethodPost, "project_task", task(map[string]any{"project_id": hidden}), 422},
		{"task in another tenant's project", me, http.MethodPost, "project_task", task(map[string]any{"project_id": foreign}), 422},
		{"task without project", me, http.MethodPost, "project_task", map[string]any{"name": "T"}, 422},
		{"stage of another project", me, http.MethodPost, "project_task", task(map[string]any{"stage_id": f.stage(q, "New")}), 422},
		{"milestone of another project", me, http.MethodPost, "project_task", task(map[string]any{"milestone_id": f.milestone(q)}), 422},
		{"parent in another project", me, http.MethodPost, "project_task", task(map[string]any{"parent_id": qTask}), 422},
		{"parent in another tenant", me, http.MethodPost, "project_task", task(map[string]any{"parent_id": foreignTask}), 422},
		{"malformed id", me, http.MethodPost, "project_task", task(map[string]any{"stage_id": "nope"}), 422},
		{"task's own parent", me, http.MethodPut, "project_task/" + pTask.String(), map[string]any{"parent_id": pTask}, 422},
		{"parent cycle", me, http.MethodPut, "project_task/" + pTask.String(), map[string]any{"parent_id": child}, 422},
		{"valid parent", me, http.MethodPost, "project_task", task(map[string]any{"parent_id": pTask, "milestone_id": f.milestone(p)}), 201},
		{"self dependency", me, http.MethodPost, "project_task_dependency", map[string]any{"task_id": a, "depends_on_id": a}, 422},
		{"dependency cycle", me, http.MethodPost, "project_task_dependency", map[string]any{"task_id": b, "depends_on_id": a}, 422},
		{"dependency on a hidden task", me, http.MethodPost, "project_task_dependency", map[string]any{"task_id": a, "depends_on_id": hiddenTask}, 422},
		{"dependency on another tenant's task", me, http.MethodPost, "project_task_dependency", map[string]any{"task_id": a, "depends_on_id": foreignTask}, 422},
		{"assignee on a hidden task", me, http.MethodPost, "project_task_user", map[string]any{"task_id": hiddenTask, "user_id": m}, 422},
		{"tag of another tenant", me, http.MethodPost, "project_task_tag", map[string]any{"task_id": a, "tag_id": foreignTag}, 422},
		{"tag", me, http.MethodPost, "project_task_tag", map[string]any{"task_id": a, "tag_id": f.tag()}, 201},
		{"timesheet on another tenant's task", me, http.MethodPost, "project_timesheet", map[string]any{"task_id": foreignTask, "hours": 1, "date": "2026-11-10"}, 422},
	})

	t.Run("stage defaults to the lowest sequence", func(t *testing.T) {
		code, body := f.do(me, http.MethodPost, "project_task", task(nil))
		if code != http.StatusCreated || body["stage_id"] != f.stage(p, "New").String() {
			t.Fatalf("%d %v, want 201 in stage New", code, body)
		}
	})
	t.Run("cross-project dependency takes its task's project", func(t *testing.T) {
		code, body := f.do(me, http.MethodPost, "project_task_dependency", map[string]any{"task_id": a, "depends_on_id": qTask, "project_id": q})
		if code != http.StatusCreated || body["project_id"] != p.String() {
			t.Fatalf("%d %v, want 201 with project_id %s", code, body, p)
		}
	})
	t.Run("assignee takes its task's project", func(t *testing.T) {
		code, body := f.do(me, http.MethodPost, "project_task_user", map[string]any{"task_id": qTask, "user_id": m, "project_id": p})
		if code != http.StatusCreated || body["project_id"] != q.String() {
			t.Fatalf("%d %v, want 201 with project_id %s", code, body, q)
		}
	})
}

func TestValidate_ManagerOnly(t *testing.T) {
	f := newFixture(t)
	m, u := f.caller(uuid.New()), f.caller(uuid.New())
	admin := f.caller(uuid.New(), AdminGroup)
	p := f.project(m.UserID, "everyone")
	hidden := f.project(m.UserID, "members")
	stage := f.stage(p, "In progress")
	member := f.member(p, uuid.New())
	f.exec(`UPDATE project_member SET deleted_at = now() WHERE id = $1`, member)
	other := f.project(m.UserID, "everyone")
	live := f.member(p, uuid.New())
	milestone := f.milestone(p)

	f.run(t, []writeCase{
		{"non-manager edits the project", u, http.MethodPut, "project/" + p.String(), map[string]any{"name": "X"}, 403},
		{"non-manager edits a hidden project", u, http.MethodPut, "project/" + hidden.String(), map[string]any{"name": "X"}, 404},
		{"manager edits the project", m, http.MethodPut, "project/" + p.String(), map[string]any{"name": "X"}, 200},
		{"admin edits the project", admin, http.MethodPut, "project/" + p.String(), map[string]any{"name": "Y"}, 200},
		{"non-manager adds a member", u, http.MethodPost, "project_member", map[string]any{"project_id": p, "user_id": u.UserID}, 403},
		{"non-manager adds a member to a hidden project", u, http.MethodPost, "project_member", map[string]any{"project_id": hidden, "user_id": u.UserID}, 422},
		{"non-manager restores a member", u, http.MethodPost, "project_member/" + member.String() + "/restore", nil, 403},
		{"manager adds a member", m, http.MethodPost, "project_member", map[string]any{"project_id": p, "user_id": u.UserID}, 201},
		{"non-manager adds a stage", u, http.MethodPost, "project_stage", map[string]any{"project_id": p, "name": "Review"}, 403},
		{"non-manager renames a stage", u, http.MethodPut, "project_stage/" + stage.String(), map[string]any{"name": "Doing"}, 403},
		{"non-manager deletes a stage", u, http.MethodDelete, "project_stage/" + stage.String(), nil, 403},
		{"non-manager deletes the project", u, http.MethodDelete, "project/" + p.String(), nil, 403},
		{"manager renames a stage", m, http.MethodPut, "project_stage/" + stage.String(), map[string]any{"name": "Doing"}, 200},
		{"stage moved to another project", m, http.MethodPut, "project_stage/" + stage.String(), map[string]any{"project_id": other}, 422},
		{"member moved to another project", m, http.MethodPut, "project_member/" + live.String(), map[string]any{"project_id": other}, 422},
		{"milestone moved to another project", m, http.MethodPut, "project_milestone/" + milestone.String(), map[string]any{"project_id": other}, 422},
		{"milestone keeps its project", m, http.MethodPut, "project_milestone/" + milestone.String(), map[string]any{"project_id": p, "name": "M2"}, 200},
	})

	t.Run("a new stage goes last", func(t *testing.T) {
		code, body := f.do(m, http.MethodPost, "project_stage", map[string]any{"project_id": p, "name": "Review"})
		if code != http.StatusCreated || body["sequence"] != float64(40) || body["closed"] != false {
			t.Fatalf("%d %v, want 201 sequence 40 open", code, body)
		}
	})
	t.Run("anyone creates a project and manages it", func(t *testing.T) {
		code, body := f.do(u, http.MethodPost, "project", map[string]any{"name": "Mine"})
		if code != http.StatusCreated || body["manager_id"] != u.UserID.String() ||
			body["visibility"] != "everyone" || body["active"] != true || body["description"] != "" {
			t.Fatalf("%d %v, want 201 managed by the creator with defaults", code, body)
		}
	})
}

func TestTimesheet_RejectsNonPositiveHours(t *testing.T) {
	f := newFixture(t)
	me := f.caller(uuid.New())
	task := f.task(f.project(uuid.New(), "everyone"), nil, nil)
	f.run(t, []writeCase{
		{"zero hours", me, http.MethodPost, "project_timesheet", map[string]any{"task_id": task, "hours": 0, "date": "2026-11-10"}, 422},
		{"negative hours", me, http.MethodPost, "project_timesheet", map[string]any{"task_id": task, "hours": -1, "date": "2026-11-10"}, 422},
		{"no date", me, http.MethodPost, "project_timesheet", map[string]any{"task_id": task, "hours": 1}, 422},
	})
}

func TestValidate_TimesheetAuthorship(t *testing.T) {
	f := newFixture(t)
	m, u := f.caller(uuid.New()), f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	task := f.task(p, nil, nil)
	theirs := f.timesheet(p, task, 1) // logged by someone else

	code, body := f.do(u, http.MethodPost, "project_timesheet", map[string]any{"task_id": task, "hours": 2, "date": "2026-11-10"})
	if code != http.StatusCreated || body["user_id"] != u.UserID.String() || body["project_id"] != p.String() {
		t.Fatalf("own line: %d %v, want 201 as the caller in the task's project", code, body)
	}
	mine := body["id"].(string)
	f.run(t, []writeCase{
		{"for someone else", u, http.MethodPost, "project_timesheet", map[string]any{"task_id": task, "user_id": m.UserID, "hours": 1, "date": "2026-11-10"}, 403},
		{"edit someone else's", u, http.MethodPut, "project_timesheet/" + theirs.String(), map[string]any{"hours": 3}, 403},
		{"delete someone else's", u, http.MethodDelete, "project_timesheet/" + theirs.String(), nil, 403},
		{"hand own line to someone else", u, http.MethodPut, "project_timesheet/" + mine, map[string]any{"user_id": m.UserID}, 403},
		{"edit own", u, http.MethodPut, "project_timesheet/" + mine, map[string]any{"hours": 3}, 200},
		{"edit own to zero", u, http.MethodPut, "project_timesheet/" + mine, map[string]any{"hours": 0}, 422},
		{"manager logs for someone else", m, http.MethodPost, "project_timesheet", map[string]any{"task_id": task, "user_id": u.UserID, "hours": 1, "date": "2026-11-10"}, 201},
		{"manager edits someone else's", m, http.MethodPut, "project_timesheet/" + theirs.String(), map[string]any{"hours": 4}, 200},
		{"delete own", u, http.MethodDelete, "project_timesheet/" + mine, nil, 204},
	})
}

func TestValidate_MilestoneReachedAt(t *testing.T) {
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	code, body := f.do(m, http.MethodPost, "project_milestone", map[string]any{"project_id": p, "name": "M", "reached_at": "2020-01-01T00:00:00Z"})
	if code != http.StatusCreated || body["reached"] != false || body["reached_at"] != nil {
		t.Fatalf("create: %d %v, want unreached without reached_at", code, body)
	}
	id := body["id"].(string)
	_, body = f.do(m, http.MethodPut, "project_milestone/"+id, map[string]any{"reached": true})
	stamped := body["reached_at"]
	if stamped == nil {
		t.Fatalf("reached: %v, want reached_at stamped", body)
	}
	_, body = f.do(m, http.MethodPut, "project_milestone/"+id, map[string]any{"name": "M2", "reached_at": nil})
	if body["reached_at"] != stamped {
		t.Errorf("unrelated edit: reached_at %v, want kept %v", body["reached_at"], stamped)
	}
	_, body = f.do(m, http.MethodPut, "project_milestone/"+id, map[string]any{"reached": false})
	if body["reached_at"] != nil {
		t.Errorf("unreached: %v, want reached_at cleared", body)
	}
}

func TestValidate_Colors(t *testing.T) {
	f := newFixture(t)
	other := f.sibling()
	m := uuid.New()
	me := f.caller(m)
	p := f.project(m, "everyone")
	hidden := f.project(uuid.New(), "members")
	a, hiddenTask := f.task(p, nil, nil), f.task(hidden, nil, nil)
	mine, foreign := f.color(), other.color()

	f.run(t, []writeCase{
		{"color without name", me, http.MethodPost, "project_color", map[string]any{"color": "#ff0000"}, 422},
		{"blank name", me, http.MethodPost, "project_color", map[string]any{"name": "  ", "color": "#ff0000"}, 422},
		{"color without color", me, http.MethodPost, "project_color", map[string]any{"name": "Red"}, 422},
		{"short hex", me, http.MethodPost, "project_color", map[string]any{"name": "Red", "color": "#f00"}, 422},
		{"named color", me, http.MethodPost, "project_color", map[string]any{"name": "Red", "color": "red"}, 422},
		{"not a string", me, http.MethodPost, "project_color", map[string]any{"name": "Red", "color": 12}, 422},
		{"bad color on edit", me, http.MethodPut, "project_color/" + mine.String(), map[string]any{"color": "#12345g"}, 422},
		{"rename keeps the color", me, http.MethodPut, "project_color/" + mine.String(), map[string]any{"name": "Renamed"}, 200},
		{"link to another tenant's color", me, http.MethodPost, "project_task_color", map[string]any{"task_id": a, "color_id": foreign}, 422},
		{"link on a hidden task", me, http.MethodPost, "project_task_color", map[string]any{"task_id": hiddenTask, "color_id": f.color()}, 422},
		{"link without color", me, http.MethodPost, "project_task_color", map[string]any{"task_id": a}, 422},
	})

	t.Run("uppercase is normalized", func(t *testing.T) {
		code, body := f.do(me, http.MethodPost, "project_color", map[string]any{"name": "Sky", "color": " #1A2B3C "})
		if code != http.StatusCreated || body["color"] != "#1a2b3c" {
			t.Fatalf("%d %v, want 201 with #1a2b3c", code, body)
		}
	})
	t.Run("a link takes its task's project, once per pair", func(t *testing.T) {
		color := f.color()
		code, body := f.do(me, http.MethodPost, "project_task_color", map[string]any{"task_id": a, "color_id": color, "project_id": hidden})
		if code != http.StatusCreated || body["project_id"] != p.String() {
			t.Fatalf("%d %v, want 201 in the task's project", code, body)
		}
		if code, body := f.do(me, http.MethodPost, "project_task_color", map[string]any{"task_id": a, "color_id": color}); code != http.StatusConflict {
			t.Fatalf("duplicate link: %d %v, want 409", code, body)
		}
	})
}
