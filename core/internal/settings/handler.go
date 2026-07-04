package settings

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// SourceLocale is the reserved preferred_locale value that forces the source
// language even when the tenant default points at a translation. It is a user
// preference only — the tenant default expresses "source" as null/empty.
const SourceLocale = "source"

// localeTagPattern accepts BCP-47-shaped tags ("fr", "pt-BR", "zh_Hant_TW"):
// a 2–3 letter primary subtag plus up to three -/_ separated subtags. Loose on
// purpose — the frontend maps tags to shipped catalogs; this only keeps junk
// (and injection payloads) out of the column.
var localeTagPattern = regexp.MustCompile(`^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8}){0,3}$`)

// ── Call-site interfaces (defined here, not at implementation) ────────────────

type userPreferenceStore interface {
	FindByID(ctx context.Context, id uuid.UUID) (auth.Users, error)
	SetPreferredLocale(ctx context.Context, userID uuid.UUID, locale *string) error
}

type settingStore interface {
	Get(ctx context.Context, tenantID uuid.UUID, key string) (string, bool, error)
	Set(ctx context.Context, tenantID uuid.UUID, key, value string) error
}

// Handler serves the self-service preference endpoints and the tenant settings
// writes. Routing decides authorization: /me/* mounts behind JWT only (the
// identity scopes every query to the caller), /settings/* mounts behind the
// permission middleware as well (deriving settings:i18n:write for PUT /settings/i18n).
type Handler struct {
	users userPreferenceStore
	store settingStore
}

// NewHandler constructs a settings Handler from concrete implementations.
func NewHandler(users *auth.UserRepository, store *Repository) *Handler {
	return &Handler{users: users, store: store}
}

// newHandlerWith constructs a Handler from interface values (used in tests).
func newHandlerWith(users userPreferenceStore, store settingStore) *Handler {
	return &Handler{users: users, store: store}
}

// ── Response / request types ──────────────────────────────────────────────────

type preferencesResponse struct {
	// PreferredLocale: the caller's own choice. null = inherit the tenant
	// default; "source" = force the untranslated source language.
	PreferredLocale *string `json:"preferred_locale"`
	// DefaultLocale: the tenant-wide default. null = source language.
	DefaultLocale *string `json:"default_locale"`
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// GetMyPreferences handles GET /api/v1/me/preferences. It returns the caller's
// display-language preference alongside the tenant default so one round-trip
// resolves the effective interface language.
func (h *Handler) GetMyPreferences(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	user, err := h.users.FindByID(c.Request().Context(), identity.UserID)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			// Token valid but the account is gone — read as unauthenticated.
			return errorJSON(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required.")
		}
		return fmt.Errorf("preferences: find user: %w", err)
	}

	defaultLocale, ok, err := h.store.Get(c.Request().Context(), identity.TenantID, DefaultLocaleKey)
	if err != nil {
		return fmt.Errorf("preferences: read default locale: %w", err)
	}

	resp := preferencesResponse{PreferredLocale: user.PreferredLocale}
	if ok && defaultLocale != "" {
		resp.DefaultLocale = &defaultLocale
	}
	return c.JSON(http.StatusOK, resp)
}

// PutMyPreferences handles PUT /api/v1/me/preferences. The caller updates only
// their own record — the user id comes from the token, never the body.
func (h *Handler) PutMyPreferences(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var req struct {
		PreferredLocale *string `json:"preferred_locale"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if req.PreferredLocale != nil && *req.PreferredLocale != SourceLocale && !localeTagPattern.MatchString(*req.PreferredLocale) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"preferred_locale must be null, \"source\", or a locale tag like \"fr\" or \"pt-BR\".")
	}

	if err := h.users.SetPreferredLocale(c.Request().Context(), identity.UserID, req.PreferredLocale); err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required.")
		}
		return fmt.Errorf("preferences: set preferred locale: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}

// PutI18nSettings handles PUT /api/v1/settings/i18n — the tenant-wide default
// interface language. Mounted behind the permission middleware, which derives
// settings:i18n:write from the route.
func (h *Handler) PutI18nSettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var req struct {
		DefaultLocale *string `json:"default_locale"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if req.DefaultLocale != nil && !localeTagPattern.MatchString(*req.DefaultLocale) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"default_locale must be null or a locale tag like \"fr\" or \"pt-BR\".")
	}

	// null is stored as "" — the tenant default has no reserved "source" value,
	// absent/empty already means the source language.
	value := ""
	if req.DefaultLocale != nil {
		value = *req.DefaultLocale
	}
	if err := h.store.Set(c.Request().Context(), identity.TenantID, DefaultLocaleKey, value); err != nil {
		return fmt.Errorf("settings: set default locale: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}

// ── helpers ───────────────────────────────────────────────────────────────────

func errorJSON(c echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    msg,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}
