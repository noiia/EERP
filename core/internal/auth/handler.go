package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"golang.org/x/crypto/bcrypt"
)

const refreshCookieName = "refresh_token"

// ── Call-site interfaces (defined here, not at implementation) ────────────────

type userQuerier interface {
	FindByEmail(ctx context.Context, email string) (Users, error)
	FindByID(ctx context.Context, id uuid.UUID) (Users, error)
	FindRoleNames(ctx context.Context, userID uuid.UUID) ([]string, error)
}

type tokenIssuer interface {
	IssueAccess(user Users, roles []string) (string, error)
	IssueRefresh(userID uuid.UUID) (string, error)
	ParseRefresh(raw string) (uuid.UUID, error)
	accessTTLSeconds() int // lowercase: only implementations in this package
	refreshTTLDuration() time.Duration
}

type refreshStorer interface {
	Save(ctx context.Context, userID uuid.UUID, rawToken string, expiresAt time.Time) error
	Validate(ctx context.Context, userID uuid.UUID, rawToken string) error
	RevokeAll(ctx context.Context, userID uuid.UUID) error
}

// Handler serves the public auth endpoints.
type Handler struct {
	users   userQuerier
	tokens  tokenIssuer
	refresh refreshStorer
}

// NewHandler constructs an auth Handler from concrete implementations.
func NewHandler(users *UserRepository, tokens *TokenService, refresh *RefreshStore, _ *PermissionRepository) *Handler {
	return &Handler{users: users, tokens: tokens, refresh: refresh}
}

// newHandlerWith constructs a Handler from interface values (used in tests).
func newHandlerWith(users userQuerier, tokens tokenIssuer, refresh refreshStorer) *Handler {
	return &Handler{users: users, tokens: tokens, refresh: refresh}
}

// ── Response types ────────────────────────────────────────────────────────────

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
}

type errorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
}

type errEnvelope struct {
	Error errorBody `json:"error"`
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// Login handles POST /api/v{version}/auth/login.
func (h *Handler) Login(c echo.Context) error {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := c.Bind(&req); err != nil {
		return h.unauthMsg(c, "Invalid email or password.")
	}

	const errMsg = "Invalid email or password."

	user, err := h.users.FindByEmail(c.Request().Context(), req.Email)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) || errors.Is(err, ErrUserNotFound) {
			// Run bcrypt comparison even when user is not found to prevent timing attacks.
			_ = bcrypt.CompareHashAndPassword([]byte("$2a$12$placeholder_hash_for_timing_____"), []byte(req.Password))
			return h.unauthMsg(c, errMsg)
		}
		return fmt.Errorf("login: %w", err)
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		return h.unauthMsg(c, errMsg)
	}

	if user.DeletedAt != nil {
		return h.unauthMsg(c, errMsg)
	}

	roles, err := h.users.FindRoleNames(c.Request().Context(), user.ID)
	if err != nil {
		return fmt.Errorf("login: find roles: %w", err)
	}

	accessToken, err := h.tokens.IssueAccess(user, roles)
	if err != nil {
		return fmt.Errorf("login: issue access token: %w", err)
	}

	rawRefresh, err := h.tokens.IssueRefresh(user.ID)
	if err != nil {
		return fmt.Errorf("login: issue refresh token: %w", err)
	}

	expiresAt := time.Now().Add(h.tokens.refreshTTLDuration())
	if err := h.refresh.Save(c.Request().Context(), user.ID, rawRefresh, expiresAt); err != nil {
		return fmt.Errorf("login: save refresh token: %w", err)
	}

	h.setRefreshCookie(c, rawRefresh, expiresAt)

	return c.JSON(http.StatusOK, tokenResponse{
		AccessToken: accessToken,
		TokenType:   "Bearer",
		ExpiresIn:   h.tokens.accessTTLSeconds(),
	})
}

// Refresh handles POST /api/v{version}/auth/refresh.
func (h *Handler) Refresh(c echo.Context) error {
	rawRefresh := h.readRefreshToken(c)
	if rawRefresh == "" {
		return h.unauthMsg(c, "Authentication required.")
	}

	userID, err := h.tokens.ParseRefresh(rawRefresh)
	if err != nil {
		return h.unauthMsg(c, "Authentication required.")
	}

	if err := h.refresh.Validate(c.Request().Context(), userID, rawRefresh); err != nil {
		if errors.Is(err, ErrTokenReplayed) {
			_ = h.refresh.RevokeAll(c.Request().Context(), userID)
		}
		return h.unauthMsg(c, "Authentication required.")
	}

	user, err := h.users.FindByID(c.Request().Context(), userID)
	if err != nil || user.DeletedAt != nil {
		return h.unauthMsg(c, "Authentication required.")
	}

	roles, err := h.users.FindRoleNames(c.Request().Context(), user.ID)
	if err != nil {
		return fmt.Errorf("refresh: find roles: %w", err)
	}

	accessToken, err := h.tokens.IssueAccess(user, roles)
	if err != nil {
		return fmt.Errorf("refresh: issue access token: %w", err)
	}

	newRefresh, err := h.tokens.IssueRefresh(user.ID)
	if err != nil {
		return fmt.Errorf("refresh: issue refresh token: %w", err)
	}

	expiresAt := time.Now().Add(h.tokens.refreshTTLDuration())
	if err := h.refresh.Save(c.Request().Context(), user.ID, newRefresh, expiresAt); err != nil {
		return fmt.Errorf("refresh: save refresh token: %w", err)
	}

	h.setRefreshCookie(c, newRefresh, expiresAt)

	return c.JSON(http.StatusOK, tokenResponse{
		AccessToken: accessToken,
		TokenType:   "Bearer",
		ExpiresIn:   h.tokens.accessTTLSeconds(),
	})
}

// Logout handles POST /api/v{version}/auth/logout.
func (h *Handler) Logout(c echo.Context) error {
	rawRefresh := h.readRefreshToken(c)
	if rawRefresh != "" {
		if userID, err := h.tokens.ParseRefresh(rawRefresh); err == nil {
			_ = h.refresh.RevokeAll(c.Request().Context(), userID)
		}
	}

	cookie := &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		Path:     "/",
	}
	c.SetCookie(cookie)
	return c.NoContent(http.StatusNoContent)
}

// ── helpers ───────────────────────────────────────────────────────────────────

func (h *Handler) readRefreshToken(c echo.Context) string {
	if cookie, err := c.Cookie(refreshCookieName); err == nil && cookie.Value != "" {
		return cookie.Value
	}
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	_ = c.Bind(&body)
	return body.RefreshToken
}

func (h *Handler) setRefreshCookie(c echo.Context, token string, expiresAt time.Time) {
	cookie := &http.Cookie{
		Name:     refreshCookieName,
		Value:    token,
		Expires:  expiresAt,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		Path:     "/",
	}
	c.SetCookie(cookie)
}

func (h *Handler) unauthMsg(c echo.Context, msg string) error {
	return c.JSON(http.StatusUnauthorized, errEnvelope{
		Error: errorBody{
			Code:      "UNAUTHENTICATED",
			Message:   msg,
			RequestID: c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}

// ErrUserNotFound is the sentinel for "user not found" that stubs can return.
var ErrUserNotFound = errors.New("user not found")
