package project

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/mcpbridge"
	authmw "core/internal/middleware"
	"core/internal/types"
	ormserver "core/orm/server"

	"github.com/google/uuid"
)

// Exercise the real MCP transport, JWT/permission middleware, project overrides,
// SQL row scopes and triggers together, under a fresh tenant only.
func TestMCPProjectAccess(t *testing.T) {
	f := newFixture(t)
	roleID := uuid.New()
	roleName := "mcp-test-" + roleID.String()
	permissionIDs := []uuid.UUID{}
	t.Cleanup(func() {
		f.exec(`DELETE FROM role_permissions WHERE role_id=$1`, roleID)
		f.exec(`DELETE FROM roles WHERE id=$1`, roleID)
		for _, id := range permissionIDs {
			f.exec(`DELETE FROM permissions WHERE id=$1`, id)
		}
	})
	f.exec(`INSERT INTO roles (id, tenant_id, name, description) VALUES ($1,$2,$3,'MCP test')`, roleID, f.tenant, roleName)
	for _, action := range []string{"read", "write", "delete"} {
		id := uuid.New()
		permissionIDs = append(permissionIDs, id)
		f.exec(`INSERT INTO permissions (id, code, description, module) VALUES ($1,$2,'MCP test','project') ON CONFLICT (code) WHERE deleted_at IS NULL DO NOTHING`, id, "*:*:"+action)
		f.exec(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1,id FROM permissions WHERE code=$2 AND deleted_at IS NULL`, roleID, "*:*:"+action)
	}
	perms := auth.NewPermissionRepository(f.app.DB)
	SetPermissions(perms)
	cfg := &types.Config{MasterPassword: strings.Repeat("m", 48), MCPRateLimitPerMinute: 10000, MCPAllowWrites: true}
	tokens := auth.NewTokenService(cfg)
	jwt, perm := authmw.JWTMiddleware(tokens), authmw.PermissionMiddleware(perms)
	s := ormserver.New(f.app, ormserver.Config{})
	handlers := ormserver.BuildHandlers(f.app)
	s.RegisterRoutes(handlers, nil, jwt, perm)
	NewHandler(f.app.DB, perms).Mount(s.Echo(), func(table string) Generic { return handlers[table] }, jwt, perm)
	mcpbridge.New(s.Echo(), perms, nil, true, nil).Mount(s.Echo(), cfg, jwt)
	manager, member, outsider := uuid.New(), uuid.New(), uuid.New()
	p := f.project(manager, "members")
	f.member(p, member)
	task := f.task(p, nil, nil)

	token := func(user, tenant uuid.UUID) string {
		u := auth.Users{}
		u.ID = user
		u.TenantID = tenant
		raw, err := tokens.IssueAccess(u, []string{roleName}, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	call := func(raw, tool string, args any) (int, map[string]any) {
		t.Helper()
		body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": args}})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("POST", mcpbridge.Path, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+raw)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2025-11-25")
		rec := httptest.NewRecorder()
		s.Echo().ServeHTTP(rec, req)
		var rpc struct {
			Result struct {
				IsError    bool `json:"isError"`
				Structured struct {
					Status int            `json:"status"`
					Data   map[string]any `json:"data"`
				} `json:"structuredContent"`
			} `json:"result"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &rpc); err != nil || rec.Code != 200 || rpc.Result.Structured.Status == 0 {
			t.Fatalf("MCP %s: %d %s (%v)", tool, rec.Code, rec.Body.String(), err)
		}
		if rpc.Result.IsError != (rpc.Result.Structured.Status >= 400) {
			t.Fatalf("incorrect error flag: %s", rec.Body.String())
		}
		return rpc.Result.Structured.Status, rpc.Result.Structured.Data
	}
	for _, tc := range []struct {
		name         string
		user, tenant uuid.UUID
		visible      bool
	}{
		{"manager", manager, f.tenant, true}, {"member", member, f.tenant, true},
		{"outsider", outsider, f.tenant, false}, {"other tenant", manager, uuid.New(), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := token(tc.user, tc.tenant)
			want := 404
			if tc.visible {
				want = 200
			}
			for _, section := range []string{"record", "metrics", "schedule", "can_manage"} {
				status, _ := call(raw, "eerp_get_project", map[string]any{"id": p.String(), "section": section})
				if status != want {
					t.Errorf("%s: %d, want %d", section, status, want)
				}
			}
			status, data := call(raw, "eerp_list_project_tasks", map[string]any{"id": p.String()})
			if status != 200 {
				t.Fatalf("tasks: %d %v", status, data)
			}
			wantTotal := float64(0)
			if tc.visible {
				wantTotal = 1
			}
			if data["total"] != wantTotal {
				t.Fatalf("task visibility: %v", data)
			}
		})
	}
	// Task assignment permits access to that task without exposing its project.
	f.assign(p, task, outsider)
	status, data := call(token(outsider, f.tenant), "eerp_list_project_tasks", map[string]any{"id": p.String()})
	if status != 200 || data["total"] != float64(1) {
		t.Fatalf("assigned task: %d %v", status, data)
	}
	status, _ = call(token(outsider, f.tenant), "eerp_get_project", map[string]any{"id": p.String()})
	if status != 404 {
		t.Fatalf("assignee saw private project: %d", status)
	}
	for _, tc := range []struct {
		user uuid.UUID
		want int
	}{{manager, 201}, {member, 403}, {outsider, 404}} {
		status, _ := call(token(tc.user, f.tenant), "eerp_write_operation", map[string]any{"operation": "POST /api/v1/project/:id/baseline", "path_params": map[string]string{"id": p.String()}, "body": map[string]string{"name": "MCP baseline"}})
		if status != tc.want {
			t.Errorf("baseline %s: %d want %d", tc.user, status, tc.want)
		}
	}
	// Project creation must use its override (defaults and initial stages), rather
	// than bypass validation by going straight to the generic repository.
	status, data = call(token(manager, f.tenant), "eerp_create_record", map[string]any{"model": "project", "data": map[string]any{"name": "MCP project"}})
	if status != 201 || data["manager_id"] != manager.String() {
		t.Fatalf("create defaults: %d %v", status, data)
	}
	created := data["id"].(string)
	var stages int
	if err := f.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM project_stage WHERE project_id=$1 AND tenant_id=$2`, created, f.tenant).Scan(&stages); err != nil || stages == 0 {
		t.Fatalf("initial stages: %d %v", stages, err)
	}
}
