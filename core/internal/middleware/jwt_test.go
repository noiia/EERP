package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/auth"
	authmw "core/internal/middleware"
	"core/internal/types"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

func newSvc() *auth.TokenService {
	return auth.NewTokenService(&types.Config{
		MasterPassword:   "test-secret-key-32-bytes-minimum!",
		AccessTTLSeconds: 3600,
	})
}

func testEcho() *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	return e
}

// recordingHandler is the sentinel handler that, if reached, records the identity.
func recordingHandler(reachedPtr *bool) echo.HandlerFunc {
	return func(c echo.Context) error {
		*reachedPtr = true
		return c.String(http.StatusOK, "ok")
	}
}

// ── JWTMiddleware ─────────────────────────────────────────────────────────────

func TestJWTMiddleware_NoHeader_Returns401(t *testing.T) {
	e := testEcho()
	svc := newSvc()
	reached := false

	e.GET("/test", recordingHandler(&reached), authmw.JWTMiddleware(svc))

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
	if reached {
		t.Error("handler must not be reached without valid token")
	}
}

func TestJWTMiddleware_InvalidToken_Returns401(t *testing.T) {
	e := testEcho()
	svc := newSvc()
	reached := false

	e.GET("/test", recordingHandler(&reached), authmw.JWTMiddleware(svc))

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer not.a.real.token")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
	if reached {
		t.Error("handler must not be reached with invalid token")
	}
}

func TestJWTMiddleware_ValidToken_InjectsIdentityAndCalls200(t *testing.T) {
	e := testEcho()
	svc := newSvc()

	user := auth.Users{
		TenantID: uuid.MustParse("00000000-0000-0000-0000-000000000001"),
	}
	user.BaseModel.ID = uuid.MustParse("00000000-0000-0000-0000-000000000002")

	raw, err := svc.IssueAccess(user, []string{"admin"})
	if err != nil {
		t.Fatalf("IssueAccess: %v", err)
	}

	var capturedIdentity auth.Identity
	e.GET("/test", func(c echo.Context) error {
		id, ok := auth.IdentityFromContext(c.Request().Context())
		if !ok {
			return c.String(http.StatusInternalServerError, "no identity")
		}
		capturedIdentity = id
		return c.String(http.StatusOK, "ok")
	}, authmw.JWTMiddleware(svc))

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer "+raw)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if capturedIdentity.UserID != user.ID {
		t.Errorf("UserID = %v, want %v", capturedIdentity.UserID, user.ID)
	}
	if capturedIdentity.TenantID != user.TenantID {
		t.Errorf("TenantID = %v, want %v", capturedIdentity.TenantID, user.TenantID)
	}
}

func TestJWTMiddleware_WrongKeyword_Returns401(t *testing.T) {
	e := testEcho()
	svc := newSvc()
	reached := false

	e.GET("/test", recordingHandler(&reached), authmw.JWTMiddleware(svc))

	user := auth.Users{TenantID: uuid.New()}
	user.BaseModel.ID = uuid.New()
	raw, _ := svc.IssueAccess(user, nil)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Token "+raw) // wrong scheme
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}
