package auth_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/types"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"golang.org/x/crypto/bcrypt"
)

func buildHandler(user auth.Users, roles []string, findErr, validateErr error) *auth.Handler {
	cfg := &types.Config{
		MasterPassword:    "test-secret-key-32-bytes-minimum!",
		AccessTTLSeconds:  3600,
		RefreshTTLSeconds: 604800,
	}
	return auth.NewHandlerForTest(user, roles, findErr, auth.NewTokenService(cfg), validateErr)
}

func buildEchoForAuth() *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	return e
}

// ── Login ─────────────────────────────────────────────────────────────────────

func TestLogin_ValidCredentials_Returns200WithToken(t *testing.T) {
	hash, _ := bcrypt.GenerateFromPassword([]byte("secret"), bcrypt.MinCost)
	user := auth.Users{
		Email:        "alice@example.com",
		PasswordHash: string(hash),
	}
	user.BaseModel.ID = uuid.New()
	user.TenantID = uuid.New()

	h := buildHandler(user, []string{"admin"}, nil, nil)
	e := buildEchoForAuth()
	e.POST("/auth/login", h.Login)

	body := `{"email":"alice@example.com","password":"secret"}`
	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := resp["access_token"]; !ok {
		t.Error("response missing access_token")
	}
	if resp["token_type"] != "Bearer" {
		t.Errorf("token_type = %v, want Bearer", resp["token_type"])
	}
	// Ensure refresh cookie is set.
	cookies := rec.Result().Cookies()
	var hasRefreshCookie bool
	for _, c := range cookies {
		if c.Name == "refresh_token" {
			hasRefreshCookie = true
			if !c.HttpOnly {
				t.Error("refresh_token cookie must be HttpOnly")
			}
		}
	}
	if !hasRefreshCookie {
		t.Error("response missing refresh_token cookie")
	}
}

func TestLogin_WrongPassword_Returns401(t *testing.T) {
	hash, _ := bcrypt.GenerateFromPassword([]byte("correct"), bcrypt.MinCost)
	user := auth.Users{Email: "alice@example.com", PasswordHash: string(hash)}
	user.BaseModel.ID = uuid.New()

	h := buildHandler(user, nil, nil, nil)
	e := buildEchoForAuth()
	e.POST("/auth/login", h.Login)

	req := httptest.NewRequest(http.MethodPost, "/auth/login",
		strings.NewReader(`{"email":"alice@example.com","password":"wrong"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestLogin_UnknownEmail_Returns401(t *testing.T) {
	h := buildHandler(auth.Users{Email: "alice@example.com"}, nil, auth.ErrUserNotFound, nil)
	e := buildEchoForAuth()
	e.POST("/auth/login", h.Login)

	req := httptest.NewRequest(http.MethodPost, "/auth/login",
		strings.NewReader(`{"email":"unknown@example.com","password":"anything"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestLogin_WrongAndUnknown_SameErrorMessage(t *testing.T) {
	hash, _ := bcrypt.GenerateFromPassword([]byte("correct"), bcrypt.MinCost)
	user := auth.Users{Email: "alice@example.com", PasswordHash: string(hash)}
	user.BaseModel.ID = uuid.New()

	e := buildEchoForAuth()
	e.POST("/wrong-pass", buildHandler(user, nil, nil, nil).Login)
	e.POST("/unknown", buildHandler(auth.Users{Email: "x"}, nil, auth.ErrUserNotFound, nil).Login)

	doReq := func(path, body string) string {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		var resp map[string]any
		json.Unmarshal(rec.Body.Bytes(), &resp) //nolint:errcheck
		if errObj, ok := resp["error"].(map[string]any); ok {
			return errObj["message"].(string)
		}
		return ""
	}

	msgWrong := doReq("/wrong-pass", `{"email":"alice@example.com","password":"bad"}`)
	msgUnknown := doReq("/unknown", `{"email":"ghost@example.com","password":"bad"}`)

	if msgWrong != msgUnknown {
		t.Errorf("messages differ (enumeration risk): wrong=%q unknown=%q", msgWrong, msgUnknown)
	}
	if msgWrong == "" {
		t.Error("error message must not be empty")
	}
}

// ── Logout ────────────────────────────────────────────────────────────────────

func TestLogout_Returns204_AndClearsCookie(t *testing.T) {
	h := buildHandler(auth.Users{}, nil, nil, nil)
	e := buildEchoForAuth()
	e.POST("/auth/logout", h.Logout)

	req := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}

	for _, c := range rec.Result().Cookies() {
		if c.Name == "refresh_token" && c.MaxAge != -1 {
			t.Error("refresh_token cookie MaxAge must be -1 (cleared)")
		}
	}
}
