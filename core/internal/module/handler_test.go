package module

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// ── Stubs ─────────────────────────────────────────────────────────────────────

type stubModuleStore struct {
	listed  []map[string]any
	listErr error

	found    map[string]any
	foundErr error

	gotID string
}

func (s *stubModuleStore) List(_ context.Context) ([]map[string]any, error) {
	return s.listed, s.listErr
}

func (s *stubModuleStore) Get(_ context.Context, id string) (map[string]any, error) {
	s.gotID = id
	return s.found, s.foundErr
}

type stubModuleRuntime struct {
	updated   map[string]any
	updateErr error

	reloaded  map[string]any
	reloadErr error

	logs    []ModuleOperationLog
	logsErr error

	gotID     string
	gotActive bool
}

func (s *stubModuleRuntime) SetActive(_ context.Context, id string, active bool) (map[string]any, error) {
	s.gotID, s.gotActive = id, active
	return s.updated, s.updateErr
}

func (s *stubModuleRuntime) Reload(_ context.Context, id string) (map[string]any, error) {
	s.gotID = id
	return s.reloaded, s.reloadErr
}

func (s *stubModuleRuntime) Logs(_ context.Context, id string) ([]ModuleOperationLog, error) {
	s.gotID = id
	return s.logs, s.logsErr
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func serveModules(t *testing.T, h echo.HandlerFunc, method, target, body string, params map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	var reader *strings.Reader
	if body != "" {
		reader = strings.NewReader(body)
	} else {
		reader = strings.NewReader("")
	}
	req := httptest.NewRequest(method, target, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	for k, v := range params {
		c.SetParamNames(k)
		c.SetParamValues(v)
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	return rec
}

func moduleErrorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error envelope: %v (body: %s)", err, rec.Body.String())
	}
	return payload.Error.Code
}

// ── GET /modules ──────────────────────────────────────────────────────────────

func TestModulesList(t *testing.T) {
	t.Run("returns the generic list envelope", func(t *testing.T) {
		store := &stubModuleStore{listed: []map[string]any{
			{"id": "crm", "name": "crm", "active": true},
			{"id": "contact", "name": "contact", "active": false},
		}}

		rec := serveModules(t, newHandlerWith(store, &stubModuleRuntime{}).List, http.MethodGet, "/api/v1/modules", "", nil)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		var got listEnvelope
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got.Total != 2 || len(got.Data) != 2 {
			t.Fatalf("envelope = %+v, want 2 entries", got)
		}
	})
}

// ── GET /modules/:id ──────────────────────────────────────────────────────────

func TestModulesGet(t *testing.T) {
	t.Run("returns the module record", func(t *testing.T) {
		store := &stubModuleStore{found: map[string]any{"id": "crm", "name": "crm", "active": true}}

		rec := serveModules(t, newHandlerWith(store, &stubModuleRuntime{}).Get, http.MethodGet, "/api/v1/modules/crm", "",
			map[string]string{"id": "crm"})

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.gotID != "crm" {
			t.Errorf("lookup id = %s, want crm", store.gotID)
		}
	})

	t.Run("unknown module is 404", func(t *testing.T) {
		store := &stubModuleStore{foundErr: ErrModuleNotFound}
		rec := serveModules(t, newHandlerWith(store, &stubModuleRuntime{}).Get, http.MethodGet, "/api/v1/modules/nope", "",
			map[string]string{"id": "nope"})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		if code := moduleErrorCode(t, rec); code != "NOT_FOUND" {
			t.Errorf("code = %s, want NOT_FOUND", code)
		}
	})
}

// ── PUT /modules/:id ──────────────────────────────────────────────────────────

func TestModulesUpdate(t *testing.T) {
	t.Run("flips the runtime gate live — no requires_restart", func(t *testing.T) {
		runtime := &stubModuleRuntime{updated: map[string]any{"id": "crm", "name": "crm", "active": false}}

		rec := serveModules(t, newHandlerWith(&stubModuleStore{}, runtime).Update, http.MethodPut, "/api/v1/modules/crm",
			`{"active":false}`, map[string]string{"id": "crm"})

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		if runtime.gotID != "crm" {
			t.Errorf("patched id = %s, want crm", runtime.gotID)
		}
		if runtime.gotActive != false {
			t.Errorf("gotActive = %v, want false", runtime.gotActive)
		}

		var resp map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if _, present := resp["requires_restart"]; present {
			t.Errorf("resp = %+v, requires_restart must not be present — the change is live", resp)
		}
		if resp["active"] != false {
			t.Errorf("active = %v, want false", resp["active"])
		}
	})

	t.Run("malformed body is 400", func(t *testing.T) {
		rec := serveModules(t, newHandlerWith(&stubModuleStore{}, &stubModuleRuntime{}).Update, http.MethodPut, "/api/v1/modules/crm",
			`not json`, map[string]string{"id": "crm"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})

	t.Run("a rejected field (e.g. app_mode) surfaces as 400 VALIDATION_ERROR", func(t *testing.T) {
		rec := serveModules(t, newHandlerWith(&stubModuleStore{}, &stubModuleRuntime{}).Update, http.MethodPut, "/api/v1/modules/crm",
			`{"app_mode":true}`, map[string]string{"id": "crm"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
		}
		if code := moduleErrorCode(t, rec); code != "VALIDATION_ERROR" {
			t.Errorf("code = %s, want VALIDATION_ERROR", code)
		}
	})

	t.Run("missing active is 400 VALIDATION_ERROR", func(t *testing.T) {
		rec := serveModules(t, newHandlerWith(&stubModuleStore{}, &stubModuleRuntime{}).Update, http.MethodPut, "/api/v1/modules/crm",
			`{}`, map[string]string{"id": "crm"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("appstore self-deactivation surfaces as 400 VALIDATION_ERROR", func(t *testing.T) {
		runtime := &stubModuleRuntime{updateErr: &ValidationError{Message: "the appstore module cannot deactivate itself."}}
		rec := serveModules(t, newHandlerWith(&stubModuleStore{}, runtime).Update, http.MethodPut, "/api/v1/modules/appstore",
			`{"active":false}`, map[string]string{"id": "appstore"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		if code := moduleErrorCode(t, rec); code != "VALIDATION_ERROR" {
			t.Errorf("code = %s, want VALIDATION_ERROR", code)
		}
	})

	t.Run("unknown module is 404", func(t *testing.T) {
		runtime := &stubModuleRuntime{updateErr: ErrModuleNotFound}
		rec := serveModules(t, newHandlerWith(&stubModuleStore{}, runtime).Update, http.MethodPut, "/api/v1/modules/nope",
			`{"active":false}`, map[string]string{"id": "nope"})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})
}

// ── POST /modules/:id/reload ─────────────────────────────────────────────────

func TestModulesReload(t *testing.T) {
	t.Run("reloads and returns the updated record", func(t *testing.T) {
		runtime := &stubModuleRuntime{reloaded: map[string]any{"id": "crm", "name": "crm", "active": true}}
		rec := serveModules(t, newHandlerWith(&stubModuleStore{}, runtime).Reload, http.MethodPost, "/api/v1/modules/crm/reload",
			"", map[string]string{"id": "crm"})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		if runtime.gotID != "crm" {
			t.Errorf("reloaded id = %s, want crm", runtime.gotID)
		}
	})

	t.Run("unknown module is 404", func(t *testing.T) {
		runtime := &stubModuleRuntime{reloadErr: ErrModuleNotFound}
		rec := serveModules(t, newHandlerWith(&stubModuleStore{}, runtime).Reload, http.MethodPost, "/api/v1/modules/nope/reload",
			"", map[string]string{"id": "nope"})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})
}

// ── GET /modules/:id/logs ─────────────────────────────────────────────────────

func TestModulesLogs(t *testing.T) {
	t.Run("returns the log envelope", func(t *testing.T) {
		runtime := &stubModuleRuntime{logs: []ModuleOperationLog{
			{OperationID: uuid.New(), ModuleName: "crm", Operation: "activate", Source: "backend", Level: "info", Message: "activate requested"},
		}}
		runtime.logs[0].CreatedAt = time.Now()

		rec := serveModules(t, newHandlerWith(&stubModuleStore{}, runtime).Logs, http.MethodGet, "/api/v1/modules/crm/logs",
			"", map[string]string{"id": "crm"})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		var got logsEnvelope
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got.Total != 1 || len(got.Data) != 1 {
			t.Fatalf("envelope = %+v, want 1 entry", got)
		}
		if got.Data[0].Operation != "activate" {
			t.Errorf("operation = %s, want activate", got.Data[0].Operation)
		}
	})
}
