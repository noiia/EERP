package app

import (
	"context"
	"core/internal/presence"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ok2xx asserts a 2xx answer (handlers differ on 200 vs 204) and returns the body.
func (f *flow) ok2xx(method, path string, body any) []byte {
	f.t.Helper()
	code, resp := f.do(method, path, body)
	if code < 200 || code > 299 {
		f.t.Fatalf("%s %s: status %d, want 2xx: %s", method, path, code, resp)
	}
	return resp
}

func TestApp_DatabaseManagement(t *testing.T) {
	f := newFlow(t)
	dbPath := "/api/v1/database-management/databases"
	withKey := func(method, path, body string) (int, string) {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Master-Key", f.a.cfg.MasterPassword)
		rec := httptest.NewRecorder()
		f.h.ServeHTTP(rec, req)
		return rec.Code, rec.Body.String()
	}

	anon := &client{t: t, h: f.h}
	if code, _ := anon.do(http.MethodGet, dbPath, nil); code != http.StatusUnauthorized {
		t.Errorf("list without master key: status %d, want 401", code)
	}
	if code, body := withKey(http.MethodGet, dbPath, ""); code != http.StatusOK {
		t.Fatalf("list: %d %s", code, body)
	}
	if code, _ := withKey(http.MethodPost, dbPath, `{"name":"Not A Valid Name!"}`); code != http.StatusBadRequest {
		t.Errorf("create with an invalid name: status %d, want 400", code)
	}

	// A scratch database: created and fully provisioned (every module's schema +
	// the default admin), then deleted — never the one the app is serving.
	name := fmt.Sprintf("eerp_apptest_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = f.a.db.DB.Exec(context.Background(), `DROP DATABASE IF EXISTS `+name+` WITH (FORCE)`)
	})
	if code, body := withKey(http.MethodPost, dbPath, `{"name":"`+name+`"}`); code != http.StatusCreated {
		t.Fatalf("create %s: %d %s", name, code, body)
	}
	if _, body := withKey(http.MethodGet, dbPath, ""); !strings.Contains(body, name) {
		t.Errorf("list lacks the new database %s: %s", name, body)
	}
	if code, body := withKey(http.MethodDelete, dbPath+"/"+name, ""); code < 200 || code > 299 {
		t.Errorf("delete %s: %d %s", name, code, body)
	}
}

func TestApp_PresenceGraphFieldsAndRights(t *testing.T) {
	f := newFlow(t)

	// Presence: a manual status, cleared again; unknown statuses are refused.
	f.ok2xx(http.MethodPut, "/api/v1/presence", map[string]any{"status": "busy"})
	f.expect(http.MethodPut, "/api/v1/presence", map[string]any{"status": "napping"}, http.StatusBadRequest)
	f.ok2xx(http.MethodPut, "/api/v1/presence", map[string]any{"status": ""})

	// Graph calculated fields.
	field := f.createAt("/api/v1/graph_fields", "graph_field", map[string]any{
		"entity": "crm", "key": "calc_app_test_score", "label": "Score", "formula": "1 + 1",
	})
	f.ok2xx(http.MethodGet, "/api/v1/graph_fields?entity=crm", nil)
	f.ok2xx(http.MethodPut, "/api/v1/graph_fields/"+field, map[string]any{
		"entity": "crm", "key": "calc_app_test_score", "label": "Score 2", "formula": "2 + 2",
	})
	f.ok2xx(http.MethodDelete, "/api/v1/graph_fields/"+field, nil)

	// Role rights: a view on a throwaway role, then one right tagged and untagged.
	role := f.createAt("/api/v1/roles", "roles", map[string]any{"name": "App test rights role", "technical_name": "app_test_rights"})
	view := f.createAt("/api/v1/role_view_permission", "role_view_permission", map[string]any{"role_id": role, "entity": "crm"})
	f.ok2xx(http.MethodPut, "/api/v1/role_view_permission/"+view, map[string]any{"role_id": role, "entity": "crm"})
	types := decode(t, f.expect(http.MethodGet, "/api/v1/account_role_types", nil, http.StatusOK))
	data, _ := types["data"].([]any)
	if len(data) == 0 {
		t.Fatal("no account_role_types seeded")
	}
	typeID := data[0].(map[string]any)["id"]
	right := f.createAt("/api/v1/role_view_permission_right", "role_view_permission_right",
		map[string]any{"role_view_permission_id": view, "account_role_type_id": typeID})
	f.ok2xx(http.MethodDelete, "/api/v1/role_view_permission_right/"+right, nil)
	f.ok2xx(http.MethodDelete, "/api/v1/role_view_permission/"+view, nil)
}

// TestApp_PresenceWebSocket drives the live socket end to end: connect as the
// admin (the tenant hub registers it), change the manual status over REST and
// receive the broadcast, disconnect, then run the absent→offline sweep.
func TestApp_PresenceWebSocket(t *testing.T) {
	f := newFlow(t)
	srv := httptest.NewServer(f.h)
	t.Cleanup(srv.Close)

	header := http.Header{"Authorization": {"Bearer " + f.token}}
	conn, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/presence", header)
	if err != nil {
		t.Fatalf("dial presence socket: %v (response %v)", err, resp)
	}
	t.Cleanup(func() { _ = conn.Close() })

	// The plain GET snapshot now lists the connected admin.
	if body := f.ok2xx(http.MethodGet, "/api/v1/presence", nil); !strings.Contains(string(body), "user_id") {
		t.Errorf("snapshot lacks the connected user: %s", body)
	}

	f.ok2xx(http.MethodPut, "/api/v1/presence", map[string]any{"status": "do_not_disturb"})
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no status broadcast received: %v", err)
		}
		if strings.Contains(string(msg), "do_not_disturb") {
			break
		}
	}
	f.ok2xx(http.MethodPut, "/api/v1/presence", map[string]any{"status": ""})
	_ = conn.Close()

	if err := presence.SweepAbsentToOffline(context.Background(), presence.NewRepository(f.a.db.DB), f.a.presenceHub); err != nil {
		t.Fatalf("sweep: %v", err)
	}
}
