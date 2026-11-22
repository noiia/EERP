package backup

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func serve(t *testing.T, svc *Service, id auth.Identity) *echo.Echo {
	t.Helper()
	e := echo.New()
	withID := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			c.SetRequest(c.Request().WithContext(auth.SetIdentity(c.Request().Context(), id)))
			return next(c)
		}
	}
	Mount(e.Group("/api/v1/backups", withID), NewHandler(svc))
	return e
}

func call(e *echo.Echo, method, path, body string) (int, map[string]any) {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestHandler_Settings(t *testing.T) {
	svc, dir := newService(t, &fakeBundler{dbs: []string{"poc", "client_a"}})
	id := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	e := serve(t, svc, id)

	before, _ := os.ReadFile(filepath.Join(dir, settingsFile))
	code, _ := call(e, http.MethodPut, "/api/v1/backups",
		`{"enabled":true,"frequency":"daily","time":"02:00","timezone":"Europe/Pariss","databases":["poc"],"retention_days":14}`)
	if code != http.StatusBadRequest {
		t.Fatalf("invalid PUT = %d", code)
	}
	if after, _ := os.ReadFile(filepath.Join(dir, settingsFile)); string(after) != string(before) {
		t.Fatal("an invalid PUT changed the settings file")
	}
	if code, _ := call(e, http.MethodPut, "/api/v1/backups", `{nope`); code != http.StatusBadRequest {
		t.Fatalf("malformed PUT = %d", code)
	}

	code, body := call(e, http.MethodPut, "/api/v1/backups",
		`{"enabled":true,"frequency":"daily","time":"02:00","timezone":"UTC","databases":["poc"],"include_s3":true,"retention_days":7,"notify_tenant_id":"`+uuid.NewString()+`"}`)
	if code != http.StatusOK || body["next_run"] == nil {
		t.Fatalf("valid PUT = %d %v", code, body)
	}
	saved, _ := LoadSettings(dir)
	if saved.NotifyTenant != id.TenantID || saved.NotifyUser != id.UserID || saved.UpdatedAt.IsZero() || saved.RetentionDays != 7 {
		t.Errorf("saved = %+v", saved)
	}

	code, body = call(e, http.MethodGet, "/api/v1/backups", "")
	settings, _ := body["settings"].(map[string]any)
	if code != http.StatusOK || settings["retention_days"] != float64(7) || body["backup_dir"] != dir || body["running"] != nil {
		t.Errorf("GET = %d %v", code, body)
	}
	if _, leaked := settings["notify_tenant_id"]; leaked {
		t.Error("GET exposes the notify tenant")
	}

	code, body = call(e, http.MethodGet, "/api/v1/backups/databases", "")
	if code != http.StatusOK || len(body["data"].([]any)) != 2 {
		t.Errorf("databases = %d %v", code, body)
	}
}

func TestHandler_RunCancelHistoryCleanup(t *testing.T) {
	b := &fakeBundler{dbs: []string{"poc"}, gate: make(chan struct{})}
	svc, dir := newService(t, b, "poc")
	e := serve(t, svc, auth.Identity{UserID: uuid.New(), TenantID: uuid.New()})

	if code, body := call(e, http.MethodPost, "/api/v1/backups/run", ""); code != http.StatusAccepted || body["status"] != "running" {
		t.Fatalf("run = %d %v", code, body)
	}
	if code, body := call(e, http.MethodPost, "/api/v1/backups/run", ""); code != http.StatusConflict {
		t.Fatalf("second run = %d %v", code, body)
	}
	if code, body := call(e, http.MethodGet, "/api/v1/backups", ""); code != http.StatusOK || body["running"] == nil {
		t.Errorf("GET while running = %d %v", code, body)
	}
	if code, body := call(e, http.MethodPost, "/api/v1/backups/cancel", ""); code != http.StatusOK || body["cancelled"] != true {
		t.Errorf("cancel = %d %v", code, body)
	}
	waitIdle(t, svc)

	b.gate = nil
	if code, _ := call(e, http.MethodPost, "/api/v1/backups/run", ""); code != http.StatusAccepted {
		t.Fatalf("run = %d", code)
	}
	waitIdle(t, svc)
	code, body := call(e, http.MethodGet, "/api/v1/backups/runs", "")
	runs, _ := body["data"].([]any)
	if code != http.StatusOK || len(runs) != 2 || runs[0].(map[string]any)["status"] != "success" || body["total"] != float64(2) {
		t.Fatalf("runs = %d %v", code, body)
	}
	_, body = call(e, http.MethodGet, "/api/v1/backups", "")
	if body["local_count"] != float64(1) || body["last_success"] == nil || body["last_failure"] == nil {
		t.Errorf("overview = %v", body)
	}
	if code, body := call(e, http.MethodPost, "/api/v1/backups/cleanup", ""); code != http.StatusOK || len(body["removed"].([]any)) != 0 {
		t.Errorf("cleanup = %d %v", code, body)
	}
	if pub, _ := ListPublished(dir); len(pub) != 1 {
		t.Errorf("cleanup removed the newest bundle: %v", pub)
	}
}

func TestHandler_RunWithoutDatabases(t *testing.T) {
	svc, _ := newService(t, &fakeBundler{})
	e := serve(t, svc, auth.Identity{UserID: uuid.New(), TenantID: uuid.New()})
	if code, _ := call(e, http.MethodPost, "/api/v1/backups/run", ""); code != http.StatusBadRequest {
		t.Errorf("run without databases = %d", code)
	}
}
