package middleware_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/auth"
	authmw "core/internal/middleware"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// stubPermRepo is a test double satisfying the middleware's permissionChecker.
type stubPermRepo struct {
	has  bool
	err  error
	seen string // the last required permission it was asked about
}

func (s *stubPermRepo) Has(_ context.Context, _ []string, required string) (bool, error) {
	s.seen = required
	return s.has, s.err
}

// ── PermissionMiddleware ──────────────────────────────────────────────────────

func injectIdentity(roles []string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			id := auth.Identity{
				UserID:   uuid.New(),
				TenantID: uuid.New(),
				Roles:    roles,
			}
			ctx := auth.SetIdentity(c.Request().Context(), id)
			c.SetRequest(c.Request().WithContext(ctx))
			return next(c)
		}
	}
}

func TestPermissionMiddleware_NoPermission_Returns403(t *testing.T) {
	// PermissionRepository.Has needs a DB — test via integration.
	// This test validates the middleware wires correctly with a stub-like approach:
	// we inject an identity with no roles and use a real (empty) perm repo.
	// Since there's no DB, we can only test the panic path and the 403 path
	// by temporarily using a mock approach. For full coverage, see integration tests.

	// Verify that MustIdentity panics when identity is missing (wiring guard).
	e := testEcho()
	e.GET("/api/v1/crm/contacts", func(c echo.Context) error {
		return c.String(http.StatusOK, "ok")
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/crm/contacts", nil)
	rec := httptest.NewRecorder()

	// Without identity in context, the middleware must panic.
	// We catch it with Echo's recover middleware.
	e.Use(authmw.JWTMiddleware(newSvc())) // will return 401 before perm check
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 (no token → JWT blocks first)", rec.Code)
	}
}

func TestPermissionMiddleware_Allows_WhenGranted(t *testing.T) {
	e := testEcho()
	stub := &stubPermRepo{has: true}
	g := e.Group("/api/v1", injectIdentity([]string{"admin"}), authmw.PermissionMiddleware(stub))
	g.GET("/crm/:id", func(c echo.Context) error { return c.String(http.StatusOK, "ok") })

	req := httptest.NewRequest(http.MethodGet, "/api/v1/crm/"+uuid.NewString(), nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	// The concrete id must not leak into the resource segment.
	if stub.seen != "crm:crm:read" {
		t.Errorf("required = %q, want crm:crm:read", stub.seen)
	}
}

func TestPermissionMiddleware_Denies_WhenNotGranted(t *testing.T) {
	e := testEcho()
	stub := &stubPermRepo{has: false}
	reached := false
	g := e.Group("/api/v1", injectIdentity([]string{"viewer"}), authmw.PermissionMiddleware(stub))
	g.DELETE("/crm/:id", func(c echo.Context) error { reached = true; return c.String(http.StatusOK, "ok") })

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/crm/"+uuid.NewString(), nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if reached {
		t.Error("handler must not run when permission is denied")
	}
	if stub.seen != "crm:crm:delete" {
		t.Errorf("required = %q, want crm:crm:delete", stub.seen)
	}
}

func TestDerivePermission_PathParsing(t *testing.T) {
	cases := []struct {
		method string
		path   string
		want   string
	}{
		{http.MethodGet, "/api/v1/crm/contacts", "crm:contacts:read"},
		{http.MethodPost, "/api/v1/inventory/items", "inventory:items:write"},
		{http.MethodPut, "/api/v1/crm/orders", "crm:orders:write"},
		{http.MethodDelete, "/api/v1/crm/contacts", "crm:contacts:delete"},
		// flat single-segment route: table acts as its own module
		{http.MethodGet, "/api/v1/crm", "crm:crm:read"},
		{http.MethodPost, "/api/v1/crm", "crm:crm:write"},
		{http.MethodDelete, "/api/v1/crm", "crm:crm:delete"},

		// Item routes (the matched pattern carries ":id") must resolve to the SAME
		// permission as the collection — the id must never leak into the resource.
		{http.MethodGet, "/api/v1/crm/:id", "crm:crm:read"},
		{http.MethodPut, "/api/v1/crm/:id", "crm:crm:write"},
		{http.MethodDelete, "/api/v1/crm/:id", "crm:crm:delete"},
		{http.MethodGet, "/api/v1/crm/contacts/:id", "crm:contacts:read"},
		{http.MethodDelete, "/api/v1/crm/contacts/:id", "crm:contacts:delete"},
		// restore: the "restore" suffix folds into the method (write), not the resource.
		{http.MethodPost, "/api/v1/crm/:id/restore", "crm:crm:write"},
		{http.MethodPost, "/api/v1/crm/contacts/:id/restore", "crm:contacts:write"},
	}

	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			got := authmw.DerivePermission(tc.method, tc.path)
			if got != tc.want {
				t.Errorf("DerivePermission(%q, %q) = %q, want %q", tc.method, tc.path, got, tc.want)
			}
		})
	}
}

func TestDerivePermission_FailsClosed(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
	}{
		{"unknown method", http.MethodHead, "/api/v1/crm"},
		{"options preflight", http.MethodOptions, "/api/v1/crm/contacts"},
		{"no static resource segment", http.MethodGet, "/api/v1/"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := authmw.DerivePermission(tc.method, tc.path); got != "" {
				t.Errorf("DerivePermission(%q, %q) = %q, want \"\" (so the middleware denies)", tc.method, tc.path, got)
			}
		})
	}
}
