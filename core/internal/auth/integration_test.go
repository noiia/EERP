//go:build integration

package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"core/internal/auth"
	authmw "core/internal/middleware"
	"core/internal/types"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"golang.org/x/crypto/bcrypt"
)

func integrationSetup(t *testing.T) (*orm.App, *types.Config) {
	t.Helper()
	dsn := os.Getenv("TEST_DSN")
	if dsn == "" {
		t.Skip("TEST_DSN not set")
	}
	cfg := &types.Config{
		MasterPassword:    "integration-test-key-at-least-32!",
		AccessTTLSeconds:  3600,
		RefreshTTLSeconds: 604800,
	}
	app, err := orm.New(orm.Config{DSN: dsn}, nil)
	if err != nil {
		t.Fatalf("orm.New: %v", err)
	}

	ctx := context.Background()
	// Ensure auth tables exist (matches what the module migration does).
	tables := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			deleted_at TIMESTAMPTZ,
			tenant_id UUID NOT NULL,
			email TEXT NOT NULL,
			password_hash TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS roles (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			deleted_at TIMESTAMPTZ,
			tenant_id UUID NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS permissions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			deleted_at TIMESTAMPTZ,
			code TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			module TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS user_roles (
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
			PRIMARY KEY (user_id, role_id)
		)`,
		`CREATE TABLE IF NOT EXISTS role_permissions (
			role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
			permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
			PRIMARY KEY (role_id, permission_id)
		)`,
		`CREATE TABLE IF NOT EXISTS refresh_tokens (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			deleted_at TIMESTAMPTZ,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			token_hash TEXT NOT NULL,
			expires_at TIMESTAMPTZ NOT NULL,
			revoked BOOLEAN NOT NULL DEFAULT FALSE
		)`,
	}
	for _, sql := range tables {
		if _, err := app.DB.Exec(ctx, sql); err != nil {
			t.Fatalf("setup table: %v", err)
		}
	}

	t.Cleanup(func() {
		app.DB.Exec(ctx, "DELETE FROM refresh_tokens") //nolint:errcheck
		app.DB.Exec(ctx, "DELETE FROM user_roles")     //nolint:errcheck
		app.DB.Exec(ctx, "DELETE FROM role_permissions") //nolint:errcheck
		app.DB.Exec(ctx, "DELETE FROM users")          //nolint:errcheck
		app.DB.Exec(ctx, "DELETE FROM roles")          //nolint:errcheck
		app.DB.Exec(ctx, "DELETE FROM permissions")    //nolint:errcheck
		app.Close()                                     //nolint:errcheck
	})
	return app, cfg
}

func seedUser(t *testing.T, db *orm.DB, email, password string, tenantID uuid.UUID) uuid.UUID {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	var id uuid.UUID
	if err := db.QueryRow(context.Background(),
		`INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
		tenantID, email, string(hash),
	).Scan(&id); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	return id
}

func seedRoleWithPermission(t *testing.T, db *orm.DB, userID uuid.UUID, tenantID uuid.UUID, permCode string) {
	t.Helper()
	ctx := context.Background()

	var roleID uuid.UUID
	if err := db.QueryRow(ctx,
		`INSERT INTO roles (tenant_id, name, description) VALUES ($1, $2, $3) RETURNING id`,
		tenantID, "test-role", "integration test role",
	).Scan(&roleID); err != nil {
		t.Fatalf("seed role: %v", err)
	}

	var permID uuid.UUID
	if err := db.QueryRow(ctx,
		`INSERT INTO permissions (code, description, module) VALUES ($1, $2, $3) RETURNING id`,
		permCode, "test permission", strings.SplitN(permCode, ":", 2)[0],
	).Scan(&permID); err != nil {
		t.Fatalf("seed permission: %v", err)
	}

	if _, err := db.Exec(ctx, `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, userID, roleID); err != nil {
		t.Fatalf("seed user_role: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, roleID, permID); err != nil {
		t.Fatalf("seed role_permission: %v", err)
	}
}

func buildTestStack(app *orm.App, cfg *types.Config) (*echo.Echo, *auth.Handler) {
	tokenSvc := auth.NewTokenService(cfg)
	refreshStore := auth.NewRefreshStore(app.DB)
	userRepo := auth.NewUserRepository(app.DB)
	permRepo := auth.NewPermissionRepository(app.DB)
	handler := auth.NewHandler(userRepo, tokenSvc, refreshStore, permRepo)

	e := echo.New()
	e.HideBanner = true
	e.Use(echo.WrapMiddleware(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set(echo.HeaderXRequestID, "test-req-id")
			next.ServeHTTP(w, r)
		})
	}))

	authGroup := e.Group("/api/v1/auth")
	authGroup.POST("/login", handler.Login)
	authGroup.POST("/refresh", handler.Refresh)
	authGroup.POST("/logout", handler.Logout)

	jwtMw := authmw.JWTMiddleware(tokenSvc)
	permMw := authmw.PermissionMiddleware(permRepo)
	api := e.Group("/api/v1", jwtMw, permMw)
	api.GET("/products", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"ok": "true"})
	})

	return e, handler
}

// ── Integration tests ─────────────────────────────────────────────────────────

func TestIntegration_Login_ValidCredentials(t *testing.T) {
	app, cfg := integrationSetup(t)
	tenantID := uuid.New()
	seedUser(t, app.DB, "alice@example.com", "hunter2", tenantID)

	e, _ := buildTestStack(app, cfg)

	body := `{"email":"alice@example.com","password":"hunter2"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d; body = %s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := resp["access_token"]; !ok {
		t.Error("missing access_token")
	}
}

func TestIntegration_Login_WrongPassword_SameAs_UnknownEmail(t *testing.T) {
	app, cfg := integrationSetup(t)
	tenantID := uuid.New()
	seedUser(t, app.DB, "bob@example.com", "correct", tenantID)

	e, _ := buildTestStack(app, cfg)

	doLogin := func(email, password string) (int, string) {
		body := `{"email":"` + email + `","password":"` + password + `"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		var resp map[string]any
		json.Unmarshal(rec.Body.Bytes(), &resp) //nolint:errcheck
		msg := ""
		if e2, ok := resp["error"].(map[string]any); ok {
			msg, _ = e2["message"].(string)
		}
		return rec.Code, msg
	}

	codeWrong, msgWrong := doLogin("bob@example.com", "wrong")
	codeUnknown, msgUnknown := doLogin("ghost@example.com", "wrong")

	if codeWrong != http.StatusUnauthorized || codeUnknown != http.StatusUnauthorized {
		t.Errorf("both must be 401: wrong=%d unknown=%d", codeWrong, codeUnknown)
	}
	if msgWrong != msgUnknown {
		t.Errorf("messages must match (anti-enumeration): wrong=%q unknown=%q", msgWrong, msgUnknown)
	}
}

func TestIntegration_PasswordHash_NeverInResponse(t *testing.T) {
	app, cfg := integrationSetup(t)
	tenantID := uuid.New()
	seedUser(t, app.DB, "carol@example.com", "secret", tenantID)

	e, _ := buildTestStack(app, cfg)

	body := `{"email":"carol@example.com","password":"secret"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if strings.Contains(rec.Body.String(), "password_hash") || strings.Contains(rec.Body.String(), "$2a$") {
		t.Error("password_hash leaked in response")
	}
}

func TestIntegration_Refresh_ValidCookie(t *testing.T) {
	app, cfg := integrationSetup(t)
	tenantID := uuid.New()
	seedUser(t, app.DB, "dave@example.com", "pass", tenantID)

	e, _ := buildTestStack(app, cfg)

	// Login to get the refresh cookie.
	loginBody := `{"email":"dave@example.com","password":"pass"}`
	loginReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(loginBody))
	loginReq.Header.Set("Content-Type", "application/json")
	loginRec := httptest.NewRecorder()
	e.ServeHTTP(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", loginRec.Code, loginRec.Body.String())
	}

	var refreshCookie *http.Cookie
	for _, c := range loginRec.Result().Cookies() {
		if c.Name == "refresh_token" {
			refreshCookie = c
		}
	}
	if refreshCookie == nil {
		t.Fatal("no refresh_token cookie after login")
	}

	// Use the cookie to refresh.
	refreshReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	refreshReq.AddCookie(refreshCookie)
	refreshRec := httptest.NewRecorder()
	e.ServeHTTP(refreshRec, refreshReq)

	if refreshRec.Code != http.StatusOK {
		t.Fatalf("refresh status = %d; body = %s", refreshRec.Code, refreshRec.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(refreshRec.Body.Bytes(), &resp) //nolint:errcheck
	if _, ok := resp["access_token"]; !ok {
		t.Error("missing access_token in refresh response")
	}
}

func TestIntegration_Refresh_RevokedToken_Returns401(t *testing.T) {
	app, cfg := integrationSetup(t)
	tenantID := uuid.New()
	seedUser(t, app.DB, "eve@example.com", "pass", tenantID)

	e, _ := buildTestStack(app, cfg)

	// Login.
	loginBody := `{"email":"eve@example.com","password":"pass"}`
	loginReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(loginBody))
	loginReq.Header.Set("Content-Type", "application/json")
	loginRec := httptest.NewRecorder()
	e.ServeHTTP(loginRec, loginReq)

	var cookie *http.Cookie
	for _, c := range loginRec.Result().Cookies() {
		if c.Name == "refresh_token" {
			cookie = c
		}
	}

	// Logout (revokes the token).
	logoutReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	logoutReq.AddCookie(cookie)
	logoutRec := httptest.NewRecorder()
	e.ServeHTTP(logoutRec, logoutReq)

	// Try to use the now-revoked cookie.
	refreshReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	refreshReq.AddCookie(cookie)
	refreshRec := httptest.NewRecorder()
	e.ServeHTTP(refreshRec, refreshReq)

	if refreshRec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for revoked token, got %d", refreshRec.Code)
	}
}

func TestIntegration_Logout_Returns204(t *testing.T) {
	app, cfg := integrationSetup(t)
	e, _ := buildTestStack(app, cfg)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}
}

func TestIntegration_ProtectedRoute_NoToken_Returns401(t *testing.T) {
	app, cfg := integrationSetup(t)
	e, _ := buildTestStack(app, cfg)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/products", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestIntegration_ProtectedRoute_ValidToken_NoPermission_Returns403(t *testing.T) {
	app, cfg := integrationSetup(t)
	tenantID := uuid.New()
	userID := seedUser(t, app.DB, "frank@example.com", "pass", tenantID)
	// Role with write-only permission — no "products:read".
	seedRoleWithPermission(t, app.DB, userID, tenantID, "inventory:items:write")

	e, _ := buildTestStack(app, cfg)

	// Login to get access token.
	loginReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"frank@example.com","password":"pass"}`))
	loginReq.Header.Set("Content-Type", "application/json")
	loginRec := httptest.NewRecorder()
	e.ServeHTTP(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login failed: %d", loginRec.Code)
	}
	var loginResp map[string]any
	json.Unmarshal(loginRec.Body.Bytes(), &loginResp) //nolint:errcheck
	accessToken, _ := loginResp["access_token"].(string)

	// Access protected route.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/products", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

func TestIntegration_ProtectedRoute_SuperAdmin_Returns200(t *testing.T) {
	app, cfg := integrationSetup(t)
	tenantID := uuid.New()
	userID := seedUser(t, app.DB, "grace@example.com", "pass", tenantID)
	seedRoleWithPermission(t, app.DB, userID, tenantID, "*:*:*")

	e, _ := buildTestStack(app, cfg)

	loginReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"grace@example.com","password":"pass"}`))
	loginReq.Header.Set("Content-Type", "application/json")
	loginRec := httptest.NewRecorder()
	e.ServeHTTP(loginRec, loginReq)
	var loginResp map[string]any
	json.Unmarshal(loginRec.Body.Bytes(), &loginResp) //nolint:errcheck
	accessToken, _ := loginResp["access_token"].(string)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/products", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
}
