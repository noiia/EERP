package project

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/auth"
	"core/internal/testdb"
	_ "core/modules/auth"
	"core/orm"
	"core/orm/access"
	ormserver "core/orm/server"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// fixture is a fresh tenant on the test database with the generic CRUD
// surface mounted; every row it seeds is deleted at the end.
type fixture struct {
	t      *testing.T
	app    *orm.App
	e      *echo.Echo
	tenant uuid.UUID
}

var projectTables = []string{
	"project_timesheet", "project_task_dependency", "project_task_tag", "project_task_user",
	"project_task", "project_milestone", "project_stage", "project_member", "project", "project_tag",
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "project")
	SetPermissions(auth.NewPermissionRepository(app.DB))
	s := ormserver.New(app, ormserver.Config{})
	handlers := ormserver.BuildHandlers(app)
	s.RegisterRoutes(handlers, nil)
	NewHandler(app.DB, auth.NewPermissionRepository(app.DB)).Mount(s.Echo(), func(t string) Generic { return handlers[t] })
	f := &fixture{t: t, app: app, e: s.Echo(), tenant: uuid.New()}
	t.Cleanup(func() {
		for _, table := range projectTables {
			_, _ = app.DB.Exec(context.Background(), `DELETE FROM `+table+` WHERE tenant_id = $1`, f.tenant)
		}
	})
	return f
}

func (f *fixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.app.DB.Exec(context.Background(), sql, args...); err != nil {
		f.t.Fatalf("exec %q: %v", sql, err)
	}
}

func (f *fixture) id(sql string, args ...any) uuid.UUID {
	f.t.Helper()
	var id uuid.UUID
	if err := f.app.DB.QueryRow(context.Background(), sql, args...).Scan(&id); err != nil {
		f.t.Fatalf("query %q: %v", sql, err)
	}
	return id
}

func (f *fixture) project(manager uuid.UUID, visibility string) uuid.UUID {
	return f.id(`INSERT INTO project (tenant_id, name, manager_id, visibility) VALUES ($1, 'P', $2, $3) RETURNING id`,
		f.tenant, manager, visibility)
}

func (f *fixture) stage(project uuid.UUID, name string) uuid.UUID {
	return f.id(`SELECT id FROM project_stage WHERE project_id = $1 AND name = $2`, project, name)
}

// task adds a task in the project's "New" stage.
func (f *fixture) task(project uuid.UUID, parent, milestone *uuid.UUID) uuid.UUID {
	return f.id(`INSERT INTO project_task (tenant_id, project_id, stage_id, parent_id, milestone_id, name)
		VALUES ($1, $2, $3, $4, $5, 'T') RETURNING id`, f.tenant, project, f.stage(project, "New"), parent, milestone)
}

func (f *fixture) member(project, user uuid.UUID) uuid.UUID {
	return f.id(`INSERT INTO project_member (tenant_id, project_id, user_id) VALUES ($1, $2, $3) RETURNING id`,
		f.tenant, project, user)
}

func (f *fixture) assign(project, task, user uuid.UUID) {
	f.exec(`INSERT INTO project_task_user (tenant_id, project_id, task_id, user_id) VALUES ($1, $2, $3, $4)`,
		f.tenant, project, task, user)
}

func (f *fixture) timesheet(project, task uuid.UUID, hours float64) uuid.UUID {
	return f.id(`INSERT INTO project_timesheet (tenant_id, project_id, task_id, user_id, date, hours)
		VALUES ($1, $2, $3, $4, now(), $5) RETURNING id`, f.tenant, project, task, uuid.New(), hours)
}

func (f *fixture) milestone(project uuid.UUID) uuid.UUID {
	return f.id(`INSERT INTO project_milestone (tenant_id, project_id, name) VALUES ($1, $2, 'M') RETURNING id`,
		f.tenant, project)
}

func (f *fixture) dependency(project, task, dependsOn uuid.UUID) uuid.UUID {
	return f.id(`INSERT INTO project_task_dependency (tenant_id, project_id, task_id, depends_on_id)
		VALUES ($1, $2, $3, $4) RETURNING id`, f.tenant, project, task, dependsOn)
}

// caller is a staff identity of the fixture's tenant.
func (f *fixture) caller(user uuid.UUID, groups ...string) auth.Identity {
	return auth.Identity{UserID: user, TenantID: f.tenant, Groups: groups}
}

// get serves path as who, the way JWTMiddleware stamps the context.
func (f *fixture) get(who auth.Identity, path string) (int, map[string]any) {
	f.t.Helper()
	ctx := auth.SetIdentity(context.Background(), who)
	ctx = access.WithTenant(ctx, who.TenantID)
	ctx = access.WithGroups(ctx, who.Groups)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/"+path, nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	f.e.ServeHTTP(rec, req)
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body
}

// total is the list total of path for who.
func (f *fixture) total(who auth.Identity, path string) int {
	f.t.Helper()
	code, body := f.get(who, path)
	if code != http.StatusOK {
		f.t.Fatalf("GET %s: %d %v", path, code, body)
	}
	n, _ := body["total"].(float64)
	return int(n)
}

func TestRowScope_MembersOnlyProject(t *testing.T) {
	f := newFixture(t)
	u1, u2, u3 := uuid.New(), uuid.New(), uuid.New()
	p := f.project(u1, "members")
	f.member(p, u2)
	task := f.task(p, nil, nil)
	f.milestone(p)
	f.timesheet(p, task, 1)

	lists := []string{"project", "project_task", "project_stage", "project_milestone", "project_timesheet", "project_member"}
	t.Run("outsider sees nothing", func(t *testing.T) {
		out := f.caller(u3)
		for _, l := range lists {
			if n := f.total(out, l); n != 0 {
				t.Errorf("%s: total %d, want 0", l, n)
			}
		}
		for _, path := range []string{"project/" + p.String(), "project_task/" + task.String()} {
			if code, _ := f.get(out, path); code != http.StatusNotFound {
				t.Errorf("GET %s: %d, want 404", path, code)
			}
		}
	})
	for name, who := range map[string]auth.Identity{
		"manager": f.caller(u1), "member": f.caller(u2), "admin": f.caller(uuid.New(), AdminGroup),
	} {
		t.Run(name+" sees everything", func(t *testing.T) {
			for _, l := range lists {
				if n := f.total(who, l); n == 0 {
					t.Errorf("%s: total 0", l)
				}
			}
			if code, _ := f.get(who, "project/"+p.String()); code != http.StatusOK {
				t.Errorf("GET project: %d", code)
			}
		})
	}
}

func TestRowScope_EveryoneProjectVisible(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	f.task(p, nil, nil)
	out := f.caller(uuid.New())
	if n := f.total(out, "project"); n != 1 {
		t.Errorf("projects: %d, want 1", n)
	}
	if n := f.total(out, "project_task"); n != 1 {
		t.Errorf("tasks: %d, want 1", n)
	}
}

func TestRowScope_AssigneeSeesOwnTaskOnly(t *testing.T) {
	f := newFixture(t)
	u4 := uuid.New()
	p := f.project(uuid.New(), "members")
	mine := f.task(p, nil, nil)
	sub := f.task(p, &mine, nil)
	other := f.task(p, nil, nil)
	f.assign(p, mine, u4)
	f.milestone(p)
	f.timesheet(p, mine, 2)
	f.timesheet(p, other, 2)
	f.dependency(p, mine, other)
	tag := f.id(`INSERT INTO project_tag (tenant_id, name) VALUES ($1, 'x') RETURNING id`, f.tenant)
	f.exec(`INSERT INTO project_task_tag (tenant_id, project_id, task_id, tag_id) VALUES ($1, $2, $3, $4)`, f.tenant, p, mine, tag)

	who := f.caller(u4)
	want := map[string]int{
		"project": 0, "project_milestone": 0, "project_member": 0,
		"project_task": 1, "project_timesheet": 1, "project_task_user": 1, "project_task_tag": 1,
		"project_task_dependency": 1, "project_stage": 3, "project_tag": 1,
	}
	for l, n := range want {
		if got := f.total(who, l); got != n {
			t.Errorf("%s: total %d, want %d", l, got, n)
		}
	}
	if code, _ := f.get(who, "project_task/"+mine.String()); code != http.StatusOK {
		t.Errorf("own task: %d, want 200", code)
	}
	for _, path := range []string{"project/" + p.String(), "project_task/" + sub.String(), "project_task/" + other.String()} {
		if code, _ := f.get(who, path); code != http.StatusNotFound {
			t.Errorf("GET %s: %d, want 404", path, code)
		}
	}
}

func TestRowScope_RevokedMemberLosesAccessImmediately(t *testing.T) {
	f := newFixture(t)
	t.Run("membership removed", func(t *testing.T) {
		u2 := uuid.New()
		p := f.project(uuid.New(), "members")
		m := f.member(p, u2)
		if n := f.total(f.caller(u2), "project?filter[id]="+p.String()); n != 1 {
			t.Fatalf("member sees %d projects, want 1", n)
		}
		f.exec(`UPDATE project_member SET deleted_at = now() WHERE id = $1`, m)
		if n := f.total(f.caller(u2), "project?filter[id]="+p.String()); n != 0 {
			t.Errorf("revoked member sees %d projects, want 0", n)
		}
	})
	t.Run("visibility narrowed", func(t *testing.T) {
		u3 := uuid.New()
		p := f.project(uuid.New(), "everyone")
		if n := f.total(f.caller(u3), "project?filter[id]="+p.String()); n != 1 {
			t.Fatalf("outsider sees %d public projects, want 1", n)
		}
		f.exec(`UPDATE project SET visibility = 'members' WHERE id = $1`, p)
		if n := f.total(f.caller(u3), "project?filter[id]="+p.String()); n != 0 {
			t.Errorf("outsider sees %d private projects, want 0", n)
		}
	})
}

func TestScope_FailsClosed(t *testing.T) {
	var none func() *auth.PermissionRepository = func() *auth.PermissionRepository { return nil }
	ctx := auth.SetIdentity(context.Background(), auth.Identity{UserID: uuid.New()})
	if _, _, err := ProjectScope(none)(ctx); err == nil {
		t.Error("no permission repository: want an error")
	}
	some := func() *auth.PermissionRepository { return &auth.PermissionRepository{} }
	if _, _, err := ChildScope(some)(context.Background()); err == nil {
		t.Error("no caller: want an error")
	}
	admin := auth.SetIdentity(context.Background(), auth.Identity{Groups: []string{AdminGroup}})
	for _, fn := range []orm.RowScopeFunc{ProjectScope(some), ChildScope(some), TaskScope(some), TaskChildScope(some), StageScope(some)} {
		if _, ok, err := fn(admin); ok || err != nil {
			t.Errorf("admin: ok=%v err=%v, want unrestricted", ok, err)
		}
	}
}

// IsAdmin's permission path: project:project:read isn't admin, *:*:* is.
func TestIsAdmin_Permissions(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	perms := auth.NewPermissionRepository(f.app.DB)
	role := func(code string) string {
		name := "project-test-" + uuid.NewString()
		permID := f.id(`SELECT id FROM permissions WHERE code = $1 AND deleted_at IS NULL LIMIT 1`, code)
		roleID := f.id(`INSERT INTO roles (tenant_id, name) VALUES ($1, $2) RETURNING id`, f.tenant, name)
		f.exec(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, roleID, permID)
		t.Cleanup(func() {
			_, _ = f.app.DB.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1`, roleID)
			_, _ = f.app.DB.Exec(ctx, `DELETE FROM roles WHERE id = $1`, roleID)
		})
		return name
	}
	for _, code := range []string{"project:project:read", "*:*:*"} {
		var exists bool
		_ = f.app.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM permissions WHERE code = $1 AND deleted_at IS NULL)`, code).Scan(&exists)
		if !exists {
			id := f.id(`INSERT INTO permissions (code) VALUES ($1) RETURNING id`, code)
			t.Cleanup(func() { _, _ = f.app.DB.Exec(ctx, `DELETE FROM permissions WHERE id = $1`, id) })
		}
	}
	for code, want := range map[string]bool{"project:project:read": false, "*:*:*": true} {
		who := auth.Identity{UserID: uuid.New(), TenantID: f.tenant, Roles: []string{role(code)}}
		if got := IsAdmin(auth.SetIdentity(ctx, who), perms); got != want {
			t.Errorf("role with %s: admin=%v, want %v", code, got, want)
		}
	}
}

// My tasks: filter[assignee]=me keeps the caller's own assigned tasks, for
// admins too; any other value is a 400.
func TestRowScope_AssignedToMe(t *testing.T) {
	f := newFixture(t)
	manager, user, admin := uuid.New(), uuid.New(), uuid.New()
	p := f.project(manager, "everyone")
	mine, adminTask := f.task(p, nil, nil), f.task(p, nil, nil)
	f.task(p, nil, nil)
	f.assign(p, mine, user)
	f.assign(p, adminTask, admin)

	for name, tc := range map[string]struct {
		who  auth.Identity
		want string
	}{
		"user":  {f.caller(user), mine.String()},
		"admin": {f.caller(admin, AdminGroup), adminTask.String()},
	} {
		t.Run(name, func(t *testing.T) {
			code, body := f.get(tc.who, "project_task?filter[assignee]=me")
			data, _ := body["data"].([]any)
			if code != http.StatusOK || len(data) != 1 || data[0].(map[string]any)["id"] != tc.want {
				t.Fatalf("got %d %v, want only %s", code, body, tc.want)
			}
			if n := f.total(tc.who, "project_task?filter[assignee]=me&distinct=project_id"); n < 0 {
				t.Fatal("distinct failed")
			}
		})
	}
	t.Run("unscoped list unchanged", func(t *testing.T) {
		if n := f.total(f.caller(user), "project_task"); n != 3 {
			t.Fatalf("total %d, want 3", n)
		}
	})
	t.Run("other value refused", func(t *testing.T) {
		if code, _ := f.get(f.caller(user), "project_task?filter[assignee]=someone"); code != http.StatusBadRequest {
			t.Fatalf("got %d, want 400", code)
		}
	})
}
