package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	"core/internal/auth"
	"core/internal/company"
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

// entitySlugPattern restricts the {entity} path param to the snake_case shape
// Go module route prefixes use (core-front/CLAUDE.md: "entity = the Go route
// prefix"). It only ever becomes part of an app_settings KEY, never SQL, but
// junk here would just produce an unreachable setting no frontend page could
// address.
var entitySlugPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// fieldNamePattern is the same sanity floor applied to a referenced field
// name. The backend does not know an entity's descriptor fields — Settings ->
// Views only ever offers real fields, sourced client-side from the registered
// ViewDescriptor — this just keeps junk out of the stored config.
var fieldNamePattern = entitySlugPattern

// tileIDPattern accepts client-generated tile ids (typically a UUID or a
// short random slug) — looser than entitySlugPattern since a tile id is not
// itself a DB identifier or a field name, just an opaque key inside the
// stored layout.
var tileIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// graphTileTypes is the closed set of Graph tile kinds (docs/roadmaps/
// list-view-modes.md, contracts table). Widget BODIES (the actual chart/stat
// rendering) are a Phase 5 frontend concern; the backend only ever stores and
// validates the tile's shape and type, never its `config` contents — that
// stays opaque JSON the frontend interprets per type.
var graphTileTypes = map[string]bool{"xy": true, "bar": true, "pie": true, "stat": true, "list": true}

// ── Call-site interfaces (defined here, not at implementation) ────────────────

type userPreferenceStore interface {
	FindByID(ctx context.Context, id uuid.UUID) (auth.Users, error)
	SetPreferredLocale(ctx context.Context, userID uuid.UUID, locale *string) error
	SetActiveCompany(ctx context.Context, userID uuid.UUID, companyID *uuid.UUID) error
}

type settingStore interface {
	Get(ctx context.Context, tenantID, companyID uuid.UUID, key string) (string, bool, error)
	Set(ctx context.Context, tenantID, companyID uuid.UUID, key, value string) error
	CloneCompanySettings(ctx context.Context, tenantID, fromCompanyID, toCompanyID uuid.UUID) error
}

// companyResolver resolves (and lazily bootstraps) the caller's active
// company, and looks one up by id for cross-tenant validation. Every
// handler below is company-scoped: settings live per-company, not per-
// tenant, since a tenant may host several (multi-company).
type companyResolver interface {
	ResolveActive(ctx context.Context, tenantID, userID uuid.UUID) (company.Company, error)
	FindByID(ctx context.Context, tenantID, id uuid.UUID) (company.Company, error)
}

// Handler serves the self-service preference endpoints and the tenant settings
// writes. Routing decides authorization: /me/* mounts behind JWT only (the
// identity scopes every query to the caller), /settings/* mounts behind the
// permission middleware as well (deriving settings:i18n:write for PUT /settings/i18n).
type Handler struct {
	users     userPreferenceStore
	store     settingStore
	companies companyResolver
}

// NewHandler constructs a settings Handler from concrete implementations.
func NewHandler(users *auth.UserRepository, store *Repository, companies *company.Repository) *Handler {
	return &Handler{users: users, store: store, companies: companies}
}

// newHandlerWith constructs a Handler from interface values (used in tests).
func newHandlerWith(users userPreferenceStore, store settingStore, companies companyResolver) *Handler {
	return &Handler{users: users, store: store, companies: companies}
}

// ── Response / request types ──────────────────────────────────────────────────

type preferencesResponse struct {
	// Email: the caller's own account email — the closest thing to a
	// "display name" this schema has (Users carries no separate name field).
	// The top bar's "Signed in as" shows this instead of the raw user id.
	Email string `json:"email"`
	// PreferredLocale: the caller's own choice. null = inherit the tenant
	// default; "source" = force the untranslated source language.
	PreferredLocale *string `json:"preferred_locale"`
	// DefaultLocale: the tenant-wide default. null = source language.
	DefaultLocale *string `json:"default_locale"`
	// NumberFormat: the tenant-wide number display format. null = the
	// frontend's built-in default. Rides along with the preferences load so
	// one round-trip seeds every client-side format mirror.
	NumberFormat *numberFormat `json:"number_format"`
	// ActiveCompany: the caller's current company (multi-company) — never
	// null once resolved, since ResolveActive always bootstraps one. Rides
	// along here so the top bar's company switcher needs no separate fetch.
	ActiveCompany *activeCompanyRef `json:"active_company"`
}

// activeCompanyRef is the minimal company shape callers need to render a
// switcher — name and id, not the full profile (address/phone/email, only
// needed by the Company settings form itself).
type activeCompanyRef struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

// numberFormat is both the stored value of NumberFormatKey and the request
// body of PUT /settings/format.
type numberFormat struct {
	DecimalSeparator   string `json:"decimal_separator"`
	ThousandsSeparator string `json:"thousands_separator"`
}

// The accepted separator sets. Small on purpose: these are display characters
// injected into every rendered number, so junk stays out of the column and out
// of the UI. Thousands may be empty (no grouping); decimal may not.
var (
	decimalSeparators   = map[string]bool{".": true, ",": true}
	thousandsSeparators = map[string]bool{"": true, " ": true, "\u00a0": true, ".": true, ",": true, "'": true}
)

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

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("preferences: resolve active company: %w", err)
	}

	defaultLocale, ok, err := h.store.Get(c.Request().Context(), identity.TenantID, active.ID, DefaultLocaleKey)
	if err != nil {
		return fmt.Errorf("preferences: read default locale: %w", err)
	}

	resp := preferencesResponse{
		Email:           user.Email,
		PreferredLocale: user.PreferredLocale,
		ActiveCompany:   &activeCompanyRef{ID: active.ID, Name: active.Name},
	}
	if ok && defaultLocale != "" {
		resp.DefaultLocale = &defaultLocale
	}

	rawFormat, ok, err := h.store.Get(c.Request().Context(), identity.TenantID, active.ID, NumberFormatKey)
	if err != nil {
		return fmt.Errorf("preferences: read number format: %w", err)
	}
	if ok && rawFormat != "" {
		var format numberFormat
		// An unparsable stored value degrades to null (frontend default) rather
		// than failing the whole preferences load — it is display config only.
		if err := json.Unmarshal([]byte(rawFormat), &format); err == nil {
			resp.NumberFormat = &format
		}
	}
	return c.JSON(http.StatusOK, resp)
}

// PutMyPreferences handles PUT /api/v1/me/preferences. The caller updates only
// their own record — the user id comes from the token, never the body.
func (h *Handler) PutMyPreferences(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var req struct {
		PreferredLocale *string    `json:"preferred_locale"`
		ActiveCompanyID *uuid.UUID `json:"active_company_id"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if req.PreferredLocale != nil && *req.PreferredLocale != SourceLocale && !localeTagPattern.MatchString(*req.PreferredLocale) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"preferred_locale must be null, \"source\", or a locale tag like \"fr\" or \"pt-BR\".")
	}

	if req.ActiveCompanyID != nil {
		// The real cross-tenant-switch defense: FindByID 404s (via
		// orm.ErrNotFound) for a company belonging to another tenant, the
		// same shape as one that doesn't exist at all — a malicious caller
		// learns nothing either way.
		if _, err := h.companies.FindByID(c.Request().Context(), identity.TenantID, *req.ActiveCompanyID); err != nil {
			if errors.Is(err, orm.ErrNotFound) {
				return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "active_company_id is not a company you belong to.")
			}
			return fmt.Errorf("preferences: validate active company: %w", err)
		}
	}

	if err := h.users.SetPreferredLocale(c.Request().Context(), identity.UserID, req.PreferredLocale); err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required.")
		}
		return fmt.Errorf("preferences: set preferred locale: %w", err)
	}
	if req.ActiveCompanyID != nil {
		if err := h.users.SetActiveCompany(c.Request().Context(), identity.UserID, req.ActiveCompanyID); err != nil {
			if errors.Is(err, orm.ErrNotFound) {
				return errorJSON(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required.")
			}
			return fmt.Errorf("preferences: set active company: %w", err)
		}
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

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}

	// null is stored as "" — the tenant default has no reserved "source" value,
	// absent/empty already means the source language.
	value := ""
	if req.DefaultLocale != nil {
		value = *req.DefaultLocale
	}
	if err := h.store.Set(c.Request().Context(), identity.TenantID, active.ID, DefaultLocaleKey, value); err != nil {
		return fmt.Errorf("settings: set default locale: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}

// PutFormatSettings handles PUT /api/v1/settings/format — the tenant-wide
// number display format. Mounted behind the permission middleware, which
// derives settings:format:write from the route.
func (h *Handler) PutFormatSettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var req numberFormat
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if !decimalSeparators[req.DecimalSeparator] {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			`decimal_separator must be "." or ",".`)
	}
	if !thousandsSeparators[req.ThousandsSeparator] {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			`thousands_separator must be "", " ", ".", ",", "'" or a narrow space.`)
	}
	if req.DecimalSeparator == req.ThousandsSeparator {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"decimal_separator and thousands_separator must differ.")
	}

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}

	value, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("settings: marshal number format: %w", err)
	}
	if err := h.store.Set(c.Request().Context(), identity.TenantID, active.ID, NumberFormatKey, string(value)); err != nil {
		return fmt.Errorf("settings: set number format: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}

// viewFieldsConfig is both the stored value of a ViewFieldsKey(entity) setting
// and the request/response body of GET|PUT /settings/views/:entity/fields.
type viewFieldsConfig struct {
	KanbanStatusField *string `json:"kanban_status_field"`
	CalendarDateField *string `json:"calendar_date_field"`
}

// GetViewFieldsSettings handles GET /api/v1/settings/views/:entity/fields —
// which field, if any, the workspace has designated as entity's Kanban status
// field and Calendar date field (docs/roadmaps/list-view-modes.md). An
// unconfigured entity returns nulls, not a 404: it's a normal state (the
// frontend's mode switcher just keeps Kanban/Calendar disabled), not an error.
// Mounted behind the permission middleware, which derives settings:views:read.
func (h *Handler) GetViewFieldsSettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	entity := c.Param("entity")
	if !entitySlugPattern.MatchString(entity) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "entity must be a lowercase snake_case identifier.")
	}

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}

	raw, ok, err := h.store.Get(c.Request().Context(), identity.TenantID, active.ID, ViewFieldsKey(entity))
	if err != nil {
		return fmt.Errorf("settings: get view fields for %s: %w", entity, err)
	}

	var resp viewFieldsConfig
	if ok && raw != "" {
		// An unparsable stored value degrades to the empty config rather than
		// failing the read — same posture as GetMyPreferences' number format.
		_ = json.Unmarshal([]byte(raw), &resp)
	}
	return c.JSON(http.StatusOK, resp)
}

// PutViewFieldsSettings handles PUT /api/v1/settings/views/:entity/fields.
// Mounted behind the permission middleware, which derives settings:views:write
// from the route.
func (h *Handler) PutViewFieldsSettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	entity := c.Param("entity")
	if !entitySlugPattern.MatchString(entity) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "entity must be a lowercase snake_case identifier.")
	}

	var req viewFieldsConfig
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if req.KanbanStatusField != nil && !fieldNamePattern.MatchString(*req.KanbanStatusField) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"kanban_status_field must be a lowercase snake_case field name.")
	}
	if req.CalendarDateField != nil && !fieldNamePattern.MatchString(*req.CalendarDateField) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"calendar_date_field must be a lowercase snake_case field name.")
	}

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}

	value, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("settings: marshal view fields for %s: %w", entity, err)
	}
	if err := h.store.Set(c.Request().Context(), identity.TenantID, active.ID, ViewFieldsKey(entity), string(value)); err != nil {
		return fmt.Errorf("settings: set view fields for %s: %w", entity, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// graphTile is one tile of an entity's Graph mode layout. Coordinates are
// integer grid units — one unit is 30px on the frontend (GRID_UNIT), a
// constant the backend never needs to know. `Config` stays opaque: the
// backend stores and round-trips it without interpreting it (Phase 5's
// per-type shapes are a frontend concern).
type graphTile struct {
	ID     string          `json:"id"`
	X      int             `json:"x"`
	Y      int             `json:"y"`
	W      int             `json:"w"`
	H      int             `json:"h"`
	Type   string          `json:"type"`
	Title  *string         `json:"title,omitempty"`
	Config json.RawMessage `json:"config"`
	// Hidden is a non-destructive frontend UI toggle (hide/restore, replacing a
	// destructive remove). omitempty + Go's false zero-value means a tile stored
	// before this field existed unmarshals as visible, never silently hidden.
	Hidden bool `json:"hidden,omitempty"`
}

// graphLayout is both the stored value of a ViewGraphKey(entity) setting and
// the request/response body of GET|PUT /settings/views/:entity/graph.
type graphLayout struct {
	Tiles []graphTile `json:"tiles"`
}

// validateGraphLayout applies the shape-level checks the contracts table
// requires (id, non-negative/non-zero geometry, closed type set, duplicate
// ids) — never the tile's `config` contents, which stay opaque JSON.
func validateGraphLayout(layout graphLayout) error {
	seen := make(map[string]bool, len(layout.Tiles))
	for _, tile := range layout.Tiles {
		if !tileIDPattern.MatchString(tile.ID) {
			return fmt.Errorf("tile id %q must be 1-64 letters, digits, - or _", tile.ID)
		}
		if seen[tile.ID] {
			return fmt.Errorf("duplicate tile id %q", tile.ID)
		}
		seen[tile.ID] = true
		if tile.X < 0 || tile.Y < 0 {
			return fmt.Errorf("tile %q: x/y must be >= 0", tile.ID)
		}
		if tile.W < 1 || tile.H < 1 {
			return fmt.Errorf("tile %q: w/h must be >= 1", tile.ID)
		}
		if !graphTileTypes[tile.Type] {
			return fmt.Errorf("tile %q: type %q is not one of xy, bar, pie, stat, list", tile.ID, tile.Type)
		}
		if tile.Title != nil && len(*tile.Title) > 200 {
			return fmt.Errorf("tile %q: title exceeds 200 characters", tile.ID)
		}
	}
	return nil
}

// GetGraphLayoutSettings handles GET /api/v1/settings/views/:entity/graph —
// entity's saved Graph mode tile layout (docs/roadmaps/list-view-modes.md).
// An unconfigured entity returns an empty tile list, not a 404: a blank
// canvas is a normal state. Mounted behind the permission middleware, which
// derives settings:views:read.
func (h *Handler) GetGraphLayoutSettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	entity := c.Param("entity")
	if !entitySlugPattern.MatchString(entity) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "entity must be a lowercase snake_case identifier.")
	}

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}

	raw, ok, err := h.store.Get(c.Request().Context(), identity.TenantID, active.ID, ViewGraphKey(entity))
	if err != nil {
		return fmt.Errorf("settings: get graph layout for %s: %w", entity, err)
	}

	resp := graphLayout{Tiles: []graphTile{}}
	if ok && raw != "" {
		// An unparsable stored value degrades to an empty canvas rather than
		// failing the read — same posture as the view-fields/preferences reads.
		var parsed graphLayout
		if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
			resp = parsed
			if resp.Tiles == nil {
				resp.Tiles = []graphTile{}
			}
		}
	}
	return c.JSON(http.StatusOK, resp)
}

// PutGraphLayoutSettings handles PUT /api/v1/settings/views/:entity/graph.
// Mounted behind the permission middleware, which derives
// settings:views:write from the route.
func (h *Handler) PutGraphLayoutSettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	entity := c.Param("entity")
	if !entitySlugPattern.MatchString(entity) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "entity must be a lowercase snake_case identifier.")
	}

	var req graphLayout
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if err := validateGraphLayout(req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
	}
	// A tile with no config in the request body unmarshals its RawMessage as
	// nil; normalize to an empty object so every stored tile round-trips a
	// valid JSON value, never a missing key.
	for i, tile := range req.Tiles {
		if len(tile.Config) == 0 {
			req.Tiles[i].Config = json.RawMessage("{}")
		}
	}

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}

	value, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("settings: marshal graph layout for %s: %w", entity, err)
	}
	if err := h.store.Set(c.Request().Context(), identity.TenantID, active.ID, ViewGraphKey(entity), string(value)); err != nil {
		return fmt.Errorf("settings: set graph layout for %s: %w", entity, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// pictureSize is both the stored value of PictureSizeKey/ModulePictureSizeKey
// and the request/response body of GET|PUT /settings/apps/:module/picture-size.
type pictureSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// validatePictureSize keeps junk (and pathological layout values) out of the
// column — generous bounds, since this only ever sizes a form thumbnail/box.
func validatePictureSize(s pictureSize) error {
	if s.Width < 16 || s.Width > 2000 {
		return fmt.Errorf("width must be between 16 and 2000")
	}
	if s.Height < 16 || s.Height > 2000 {
		return fmt.Errorf("height must be between 16 and 2000")
	}
	return nil
}

// pictureSizeKeyFor resolves which app_settings key a :module path segment
// addresses: the literal "base" targets the workspace-wide default
// (PictureSizeKey); any other module slug targets its own override
// (ModulePictureSizeKey). The base-vs-override MERGE is a frontend concern
// (Settings -> Apps fetches both and resolves precedence) — this handler, like
// every other settings handler in this file, only ever reads/writes ONE key.
func pictureSizeKeyFor(module string) string {
	if module == "base" {
		return PictureSizeKey
	}
	return ModulePictureSizeKey(module)
}

// GetPictureSizeSettings handles GET /api/v1/settings/apps/:module/picture-size
// — the boolean/picture widget's box size, either the workspace-wide Base
// default (module == "base") or one specific app's own override. Unset
// returns {"size": null}, not a 404: "inheriting Base" (or, for Base itself,
// "using the frontend's hardcoded default") is a normal state. Mounted behind
// the permission middleware, which derives settings:apps:read from the route.
func (h *Handler) GetPictureSizeSettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	module := c.Param("module")
	if !entitySlugPattern.MatchString(module) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "module must be a lowercase snake_case identifier.")
	}

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}

	raw, ok, err := h.store.Get(c.Request().Context(), identity.TenantID, active.ID, pictureSizeKeyFor(module))
	if err != nil {
		return fmt.Errorf("settings: get picture size for %s: %w", module, err)
	}

	resp := struct {
		Size *pictureSize `json:"size"`
	}{}
	if ok && raw != "" {
		// An unparsable stored value degrades to null rather than failing the
		// read — same posture as every other settings GET in this file.
		var size pictureSize
		if err := json.Unmarshal([]byte(raw), &size); err == nil {
			resp.Size = &size
		}
	}
	return c.JSON(http.StatusOK, resp)
}

// PutPictureSizeSettings handles PUT /api/v1/settings/apps/:module/picture-size.
// {"size": null} clears the module's own value back to "" — the same
// "empty string means unset" convention PutI18nSettings already established
// for DefaultLocaleKey — so a module can revert to inheriting Base (or Base
// itself can revert to the frontend's hardcoded default) with no separate
// delete endpoint. Mounted behind the permission middleware, which derives
// settings:apps:write from the route.
func (h *Handler) PutPictureSizeSettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	module := c.Param("module")
	if !entitySlugPattern.MatchString(module) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "module must be a lowercase snake_case identifier.")
	}

	var req struct {
		Size *pictureSize `json:"size"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}

	value := ""
	if req.Size != nil {
		if err := validatePictureSize(*req.Size); err != nil {
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
		}
		marshaled, err := json.Marshal(req.Size)
		if err != nil {
			return fmt.Errorf("settings: marshal picture size for %s: %w", module, err)
		}
		value = string(marshaled)
	}

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}

	if err := h.store.Set(c.Request().Context(), identity.TenantID, active.ID, pictureSizeKeyFor(module), value); err != nil {
		return fmt.Errorf("settings: set picture size for %s: %w", module, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// reportsLayoutMaxLen bounds footer/address so a workspace can't stuff an
// unbounded blob into a value that gets stamped on every generated PDF.
const reportsLayoutMaxLen = 5000

// reportsLayout is both the stored value of ReportsLayoutKey and the
// request/response body of GET|PUT /settings/reports/layout.
type reportsLayout struct {
	Footer  string `json:"footer"`
	Address string `json:"address"`
}

// GetReportsLayoutSettings handles GET /api/v1/settings/reports/layout — the
// workspace-wide footer/address text stamped on every generated PDF report.
// Absent returns empty strings, not a 404: no letterhead configured yet is a
// normal state. Mounted behind the permission middleware, which derives
// settings:reports:read from the route.
func (h *Handler) GetReportsLayoutSettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}

	raw, ok, err := h.store.Get(c.Request().Context(), identity.TenantID, active.ID, ReportsLayoutKey)
	if err != nil {
		return fmt.Errorf("settings: get reports layout: %w", err)
	}

	var resp reportsLayout
	if ok && raw != "" {
		// An unparsable stored value degrades to the empty layout rather than
		// failing the read — same posture as every other settings GET here.
		_ = json.Unmarshal([]byte(raw), &resp)
	}
	return c.JSON(http.StatusOK, resp)
}

// PutReportsLayoutSettings handles PUT /api/v1/settings/reports/layout.
// Mounted behind the permission middleware, which derives
// settings:reports:write from the route.
func (h *Handler) PutReportsLayoutSettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var req reportsLayout
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if len(req.Footer) > reportsLayoutMaxLen {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			fmt.Sprintf("footer exceeds %d characters", reportsLayoutMaxLen))
	}
	if len(req.Address) > reportsLayoutMaxLen {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			fmt.Sprintf("address exceeds %d characters", reportsLayoutMaxLen))
	}

	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}

	value, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("settings: marshal reports layout: %w", err)
	}
	if err := h.store.Set(c.Request().Context(), identity.TenantID, active.ID, ReportsLayoutKey, string(value)); err != nil {
		return fmt.Errorf("settings: set reports layout: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}

// CloneCompanySettings handles POST /api/v1/company/:id/clone-settings —
// copies every setting from the company named by :id (the source, normally
// the caller's own active company at the moment they create a new one) to
// target_company_id. Mounted behind the permission middleware, which
// derives company:company:write from the route — the same permission
// creating a company already requires. Both companies must belong to the
// caller's own tenant (the same cross-tenant-probe defense PutMyPreferences
// applies to active_company_id).
func (h *Handler) CloneCompanySettings(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	sourceID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id must be a UUID.")
	}
	var req struct {
		TargetCompanyID uuid.UUID `json:"target_company_id"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}

	if _, err := h.companies.FindByID(c.Request().Context(), identity.TenantID, sourceID); err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id is not a company you belong to.")
		}
		return fmt.Errorf("settings: validate clone source company: %w", err)
	}
	if _, err := h.companies.FindByID(c.Request().Context(), identity.TenantID, req.TargetCompanyID); err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "target_company_id is not a company you belong to.")
		}
		return fmt.Errorf("settings: validate clone target company: %w", err)
	}

	if err := h.store.CloneCompanySettings(c.Request().Context(), identity.TenantID, sourceID, req.TargetCompanyID); err != nil {
		return fmt.Errorf("settings: clone company settings: %w", err)
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
