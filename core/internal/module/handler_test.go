package module

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

// ── Stub ──────────────────────────────────────────────────────────────────────

type stubModuleStore struct {
	listed  []map[string]any
	listErr error

	found    map[string]any
	foundErr error

	updated   map[string]any
	updateErr error

	gotID      string
	gotChanges map[string]any
}

func (s *stubModuleStore) List(_ context.Context) ([]map[string]any, error) {
	return s.listed, s.listErr
}

func (s *stubModuleStore) Get(_ context.Context, id string) (map[string]any, error) {
	s.gotID = id
	return s.found, s.foundErr
}

func (s *stubModuleStore) Patch(_ context.Context, id string, changes map[string]any) (map[string]any, error) {
	s.gotID, s.gotChanges = id, changes
	return s.updated, s.updateErr
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

		rec := serveModules(t, newHandlerWith(store).List, http.MethodGet, "/api/v1/modules", "", nil)

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

		rec := serveModules(t, newHandlerWith(store).Get, http.MethodGet, "/api/v1/modules/crm", "",
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
		rec := serveModules(t, newHandlerWith(store).Get, http.MethodGet, "/api/v1/modules/nope", "",
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
	t.Run("patches active and adds requires_restart: true", func(t *testing.T) {
		store := &stubModuleStore{updated: map[string]any{"id": "crm", "name": "crm", "active": false}}

		rec := serveModules(t, newHandlerWith(store).Update, http.MethodPut, "/api/v1/modules/crm",
			`{"active":false}`, map[string]string{"id": "crm"})

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.gotID != "crm" {
			t.Errorf("patched id = %s, want crm", store.gotID)
		}
		if active, ok := store.gotChanges["active"]; !ok || active != false {
			t.Errorf("changes = %+v, want {active: false}", store.gotChanges)
		}

		var resp map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp["requires_restart"] != true {
			t.Errorf("requires_restart = %v, want true", resp["requires_restart"])
		}
		if resp["active"] != false {
			t.Errorf("active = %v, want false", resp["active"])
		}
	})

	t.Run("malformed body is 400", func(t *testing.T) {
		store := &stubModuleStore{}
		rec := serveModules(t, newHandlerWith(store).Update, http.MethodPut, "/api/v1/modules/crm",
			`not json`, map[string]string{"id": "crm"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})

	t.Run("a rejected field (e.g. app_mode) surfaces as 400 VALIDATION_ERROR", func(t *testing.T) {
		store := &stubModuleStore{updateErr: &ValidationError{Message: `"app_mode" is not a writable field.`}}
		rec := serveModules(t, newHandlerWith(store).Update, http.MethodPut, "/api/v1/modules/crm",
			`{"app_mode":true}`, map[string]string{"id": "crm"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
		}
		if code := moduleErrorCode(t, rec); code != "VALIDATION_ERROR" {
			t.Errorf("code = %s, want VALIDATION_ERROR", code)
		}
	})

	t.Run("appstore self-deactivation surfaces as 400 VALIDATION_ERROR", func(t *testing.T) {
		store := &stubModuleStore{updateErr: &ValidationError{Message: "the appstore module cannot deactivate itself."}}
		rec := serveModules(t, newHandlerWith(store).Update, http.MethodPut, "/api/v1/modules/appstore",
			`{"active":false}`, map[string]string{"id": "appstore"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		if code := moduleErrorCode(t, rec); code != "VALIDATION_ERROR" {
			t.Errorf("code = %s, want VALIDATION_ERROR", code)
		}
	})

	t.Run("unknown module is 404", func(t *testing.T) {
		store := &stubModuleStore{updateErr: ErrModuleNotFound}
		rec := serveModules(t, newHandlerWith(store).Update, http.MethodPut, "/api/v1/modules/nope",
			`{"active":false}`, map[string]string{"id": "nope"})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})
}
