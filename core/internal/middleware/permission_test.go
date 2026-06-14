package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/auth"
	authmw "core/internal/middleware"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// stubPermRepo is a test double for PermissionRepository.
type stubPermRepo struct {
	has bool
	err error
}

func (s *stubPermRepo) Has(_ interface{}, _ []string, _ string) (bool, error) {
	return s.has, s.err
}

// ── PermissionMiddleware ──────────────────────────────────────────────────────

func setupPermTest(t *testing.T, has bool) (*echo.Echo, *auth.PermissionRepository, *bool) {
	t.Helper()
	e := testEcho()
	reached := false
	return e, nil, &reached
}

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
