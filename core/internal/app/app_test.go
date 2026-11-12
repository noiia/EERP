package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"core/internal/auth"
	"core/internal/common"
	"core/internal/testdb"
	"core/internal/types"

	"github.com/google/uuid"
)

func TestMain(m *testing.M) {
	if err := common.InitLogger(false); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func TestBuild_RejectsBadConfig(t *testing.T) {
	badYAML := filepath.Join(t.TempDir(), "api.yaml")
	if err := os.WriteFile(badYAML, []byte("not: [valid"), 0o600); err != nil {
		t.Fatal(err)
	}
	const key = "a-master-key-long-enough-to-sign-jwts-0123456789"
	valid := types.Config{MasterPassword: key, DbPassword: "a-db-password", Environment: "development"}
	with := func(mod func(*types.Config)) types.Config { c := valid; mod(&c); return c }
	tests := []struct {
		name string
		cfg  types.Config
	}{
		{"empty master key", with(func(c *types.Config) { c.MasterPassword = "" })},
		{"template master key", with(func(c *types.Config) { c.MasterPassword = "change-me-in-production" })},
		{"master key leaked in repo history", with(func(c *types.Config) { c.MasterPassword = "ueioiehsiuehfs" })},
		{"master key too short", with(func(c *types.Config) { c.MasterPassword = "short" })},
		{"empty db password", with(func(c *types.Config) { c.DbPassword = "" })},
		{"db password leaked in repo history", with(func(c *types.Config) { c.DbPassword = "postgres" })},
		{"smtp_tls typo", with(func(c *types.Config) { c.SMTPHost, c.SMTPFrom, c.SMTPTLS = "h", "a@x.io", "starttsl" })},
		{"smtp_from empty", with(func(c *types.Config) { c.SMTPHost = "h" })},
		{"unknown environment", with(func(c *types.Config) { c.Environment = "staging" })},
		{"missing api config file", with(func(c *types.Config) { c.ApiConfigPath = filepath.Join(t.TempDir(), "nope.yaml") })},
		{"malformed api config file", with(func(c *types.Config) { c.ApiConfigPath = badYAML })},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Build(context.Background(), &tt.cfg, "", false); err == nil {
				t.Fatal("Build succeeded, want an error")
			}
		})
	}
}

// client drives the built app in-process, as the seeded dev admin.
type client struct {
	t     *testing.T
	h     http.Handler
	a     *App
	token string
}

func (c *client) do(method, path string, body any) (int, []byte) {
	c.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			c.t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// decode unmarshals a JSON response body into a map.
func decode(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return m
}

// buildApp boots the whole backend against the test database, with the dev
// admin seeded, and returns a client logged in as that admin.
func buildApp(t *testing.T) *client {
	t.Helper()
	return buildAppWith(t, nil)
}

// buildAppWith is buildApp with the config adjusted first (nil = as is).
func buildAppWith(t *testing.T, adjust func(*types.Config)) *client {
	t.Helper()
	cfg := testdb.Config(t)
	cfg.Environment = "development" // no forced password change for the seeded admin
	cfg.CronLogDir = t.TempDir()
	if adjust != nil {
		adjust(cfg)
	}

	a, err := Build(context.Background(), cfg, "", false)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	t.Cleanup(a.Close)

	c := &client{t: t, h: a.Handler(), a: a}
	code, body := c.do(http.MethodPost, "/api/v1/auth/login",
		map[string]string{"email": auth.DevAdminEmail, "password": auth.DevAdminPassword})
	if code != http.StatusOK {
		t.Fatalf("login: %d %s", code, body)
	}
	c.token, _ = decode(t, body)["access_token"].(string)
	return c
}

func TestApp_Routes(t *testing.T) {
	c := buildApp(t)

	tests := []struct {
		method string
		path   string
		body   any
		want   int
	}{
		{http.MethodGet, "/health", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/me/preferences", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/me/view_layout/project_task/wbs", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/notifications", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/views/crm/fields", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/views/crm/graph", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/views/crm/chatter", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/integrations/osm", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/tax", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/accounts", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/settings/reports/layout", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/modules", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/modules/sale", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/modules/sale/logs", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/views", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/users", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/roles", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/crm", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/invoice", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/quote", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/property_management", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/cron", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/cron_history", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/notebook_pages?table=crm&record=00000000-0000-0000-0000-000000000001", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/saved_filters?entity=crm", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/mail_outbox", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/chatter_messages?table=crm&record=00000000-0000-0000-0000-000000000001", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/teams", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/project", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/project_task", nil, http.StatusOK},
		{http.MethodGet, "/api/v1/nope", nil, http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			if code, body := c.do(tt.method, tt.path, tt.body); code != tt.want {
				t.Errorf("status = %d, want %d: %s", code, tt.want, body)
			}
		})
	}

	t.Run("no token is rejected", func(t *testing.T) {
		anon := &client{t: t, h: c.h}
		if code, _ := anon.do(http.MethodGet, "/api/v1/crm", nil); code != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", code)
		}
	})
}

// TestApp_ProjectFlow drives the project overrides through the real routes:
// creation defaults, can_manage, the task's first stage, a timesheet, a
// refused then accepted project delete.
func TestApp_ProjectFlow(t *testing.T) {
	f := newFlow(t)
	project := f.createAt("/api/v1/project", "project", map[string]any{"name": "App test project"})
	// createAt hard-deletes each row it created by id; this also removes the
	// rows the project's triggers and writes created around them, by project id.
	var task string
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = f.a.db.DB.Exec(ctx, `DELETE FROM chatter_message WHERE (table_name = 'project' AND record_id::text = $1)
			OR (table_name = 'project_task' AND record_id::text = $2)`, project, task)
		for _, table := range []string{"project_timesheet", "project_task_user", "project_task_tag", "project_task_dependency",
			"project_task", "project_milestone", "project_member", "project_stage"} {
			_, _ = f.a.db.DB.Exec(ctx, `DELETE FROM `+table+` WHERE project_id = $1`, project)
		}
		_, _ = f.a.db.DB.Exec(ctx, `DELETE FROM project WHERE id = $1`, project)
	})
	body := f.expect(http.MethodGet, "/api/v1/project/"+project+"/can_manage", nil, http.StatusOK)
	if decode(t, body)["can_manage"] != true {
		t.Errorf("admin can_manage: %s", body)
	}
	task = f.createAt("/api/v1/project_task", "project_task", map[string]any{"project_id": project, "name": "T"})
	f.createAt("/api/v1/project_timesheet", "project_timesheet", map[string]any{"task_id": task, "hours": 2, "date": "2026-11-10"})
	f.expect(http.MethodPut, "/api/v1/project_task/"+task, map[string]any{"name": "Renamed"}, http.StatusOK)
	f.expect(http.MethodPost, "/api/v1/project_timesheet", map[string]any{"task_id": task, "hours": 0, "date": "2026-11-10"}, http.StatusUnprocessableEntity)
	f.expect(http.MethodDelete, "/api/v1/project/"+project, nil, http.StatusConflict)
	f.expect(http.MethodDelete, "/api/v1/project_task/"+task, nil, http.StatusNoContent)
	f.expect(http.MethodDelete, "/api/v1/project/"+project, nil, http.StatusNoContent)
}

// TestApp_ProjectChatterHidden: the chatter of a task in a members-only
// project answers 404 to a staff user who isn't a member (the record-anchored
// services check the row scope), and 200 on a public project's task.
func TestApp_ProjectChatterHidden(t *testing.T) {
	f := newFlow(t)
	ctx := context.Background()
	db := f.a.db.DB
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	const code = "chatter_messages:chatter_messages:read"
	var permID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM permissions WHERE code = $1 AND deleted_at IS NULL LIMIT 1`, code).Scan(&permID); err != nil {
		if err := db.QueryRow(ctx, `INSERT INTO permissions (code) VALUES ($1) RETURNING id`, code).Scan(&permID); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = db.Exec(ctx, `DELETE FROM permissions WHERE id = $1`, permID) })
	}
	role := "app-test-chatter-" + uuid.NewString()
	var roleID uuid.UUID
	if err := db.QueryRow(ctx, `INSERT INTO roles (tenant_id, name) VALUES ($1, $2) RETURNING id`, auth.DevTenantID, role).Scan(&roleID); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, roleID, permID)
	t.Cleanup(func() {
		_, _ = db.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1`, roleID)
		_, _ = db.Exec(ctx, `DELETE FROM roles WHERE id = $1`, roleID)
	})

	taskIn := func(visibility string) string {
		var project, task string
		if err := db.QueryRow(ctx, `INSERT INTO project (tenant_id, name, manager_id, visibility) VALUES ($1, 'App test', $2, $3)
			RETURNING id`, auth.DevTenantID, uuid.New(), visibility).Scan(&project); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(ctx, `INSERT INTO project_task (tenant_id, project_id, name) VALUES ($1, $2, 'T') RETURNING id`,
			auth.DevTenantID, project).Scan(&task); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			for _, table := range []string{"project_task", "project_stage"} {
				_, _ = db.Exec(ctx, `DELETE FROM `+table+` WHERE project_id = $1`, project)
			}
			_, _ = db.Exec(ctx, `DELETE FROM project WHERE id = $1`, project)
		})
		return task
	}
	hidden, public := taskIn("members"), taskIn("everyone")

	user := auth.Users{TenantID: auth.DevTenantID}
	user.ID = uuid.New()
	token, err := auth.NewTokenService(testdb.Config(t)).IssueAccess(user, []string{role}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	staff := &client{t: t, h: f.h, token: token}
	for task, want := range map[string]int{hidden: http.StatusNotFound, public: http.StatusOK} {
		if code, body := staff.do(http.MethodGet, "/api/v1/chatter_messages?table=project_task&record="+task, nil); code != want {
			t.Errorf("chatter of %s: %d, want %d: %s", task, code, want, body)
		}
	}
}
