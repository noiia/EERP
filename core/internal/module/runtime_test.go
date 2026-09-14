package module

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

// These tests exercise Registry's pure in-memory logic (the active gate,
// route-table parsing, self-protection) without a live Postgres — Registry
// is built as a struct literal rather than via NewRegistry, so opLogs/manager
// stay nil; OpLogger.Log degrades to a zap-only no-op when its repo is nil
// (oplog.go), which is exactly what lets these paths run DB-free.

func TestRegistry_IsTableActive(t *testing.T) {
	r := &Registry{
		active:     map[string]bool{"crm": true, "contact": false},
		tableOwner: map[string]string{"crm": "crm", "contact": "contact"},
	}

	t.Run("active module's table is active", func(t *testing.T) {
		if !r.IsTableActive("crm") {
			t.Error("crm should be active")
		}
	})
	t.Run("deactivated module's table is inactive", func(t *testing.T) {
		if r.IsTableActive("contact") {
			t.Error("contact should be inactive")
		}
	})
	t.Run("a table no module owns is never gated", func(t *testing.T) {
		if !r.IsTableActive("users") {
			t.Error("unowned table (users) should never be gated")
		}
	})
}

func TestRouteTable(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/api/v1/crm", "crm"},
		{"/api/v1/crm/:id", "crm"},
		{"/api/v1/crm/:id/restore", "crm"},
		{"/api/v1/auth/login", "auth"},
		{"/health", ""},
	}
	for _, tt := range tests {
		if got := routeTable(tt.path); got != tt.want {
			t.Errorf("routeTable(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestActiveGateMiddleware(t *testing.T) {
	r := &Registry{
		active:     map[string]bool{"crm": false},
		tableOwner: map[string]string{"crm": "crm"},
	}
	mw := r.ActiveGateMiddleware()

	e := echo.New()

	t.Run("403s a deactivated module's route", func(t *testing.T) {
		handlerCalled := false
		next := func(c echo.Context) error {
			handlerCalled = true
			return c.NoContent(http.StatusOK)
		}
		req := httptest.NewRequest(http.MethodGet, "/api/v1/crm", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetPath("/api/v1/crm")

		if err := mw(next)(c); err != nil {
			t.Fatalf("middleware: %v", err)
		}
		if handlerCalled {
			t.Error("next handler ran for a deactivated module")
		}
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403 (body: %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("passes through an active module's route", func(t *testing.T) {
		r.mu.Lock()
		r.active["crm"] = true
		r.mu.Unlock()

		handlerCalled := false
		next := func(c echo.Context) error {
			handlerCalled = true
			return c.NoContent(http.StatusOK)
		}
		req := httptest.NewRequest(http.MethodGet, "/api/v1/crm", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetPath("/api/v1/crm")

		if err := mw(next)(c); err != nil {
			t.Fatalf("middleware: %v", err)
		}
		if !handlerCalled {
			t.Error("next handler did not run for an active module")
		}
	})

	t.Run("passes through routes no module owns", func(t *testing.T) {
		handlerCalled := false
		next := func(c echo.Context) error {
			handlerCalled = true
			return c.NoContent(http.StatusOK)
		}
		req := httptest.NewRequest(http.MethodGet, "/api/v1/users", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetPath("/api/v1/users")

		if err := mw(next)(c); err != nil {
			t.Fatalf("middleware: %v", err)
		}
		if !handlerCalled {
			t.Error("next handler did not run for an unowned table")
		}
	})
}

func TestRegistry_SetActive_AppstoreSelfProtection(t *testing.T) {
	r := &Registry{active: map[string]bool{appstoreModuleName: true}}
	_, err := r.SetActive(context.Background(), appstoreModuleName, false)
	var verr *ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("err = %v (%T), want *ValidationError", err, err)
	}
	if !r.active[appstoreModuleName] {
		t.Error("appstore's active flag must not have flipped")
	}
}

func TestRegistry_SetActive_UnknownModule(t *testing.T) {
	r := &Registry{active: map[string]bool{}}
	_, err := r.SetActive(context.Background(), "nope", true)
	if !errors.Is(err, ErrModuleNotFound) {
		t.Fatalf("err = %v, want ErrModuleNotFound", err)
	}
}

func TestRegistry_Reload_UnknownModule(t *testing.T) {
	r := &Registry{modType: map[string]string{}}
	_, err := r.Reload(context.Background(), "nope")
	if !errors.Is(err, ErrModuleNotFound) {
		t.Fatalf("err = %v, want ErrModuleNotFound", err)
	}
}
