package providers

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type Deps struct {
	Store  *Store
	Tenant uuid.UUID // auth tenant; uuid.Nil = only local login exists
	// Roles lists the tenant's role ids (validation of the mapping).
	Roles func(ctx context.Context, tenant uuid.UUID) (map[uuid.UUID]bool, error)
}

type Handler struct{ deps Deps }

func NewHandler(deps Deps) *Handler { return &Handler{deps: deps} }

// settingsView is the GET shape: secrets replaced by has_* flags.
type settingsView struct {
	Methods
	LDAP        *ldapView  `json:"ldap,omitempty"`
	OIDC        []oidcView `json:"oidc"`
	CallbackURL string     `json:"callback_url"`
}

type ldapView struct {
	LDAPConfig
	BindPassword    string `json:"bind_password,omitempty"` // always "" — shadows the embedded field
	HasBindPassword bool   `json:"has_bind_password"`
}

type oidcView struct {
	OIDCProvider
	ClientSecret    string `json:"client_secret,omitempty"`
	HasClientSecret bool   `json:"has_client_secret"`
}

// GetSettings handles GET /api/v1/settings/auth (settings:auth:read).
func (h *Handler) GetSettings(c *echo.Context) error {
	m, err := h.deps.Store.Load(c.Request().Context(), h.deps.Tenant)
	if err != nil {
		return err
	}
	v := settingsView{Methods: m, OIDC: []oidcView{}, CallbackURL: m.CallbackURL()}
	if m.LDAP != nil {
		v.LDAP = &ldapView{LDAPConfig: *m.LDAP, HasBindPassword: m.LDAP.BindPassword != ""}
	}
	for _, p := range m.OIDC {
		v.OIDC = append(v.OIDC, oidcView{OIDCProvider: p, HasClientSecret: p.ClientSecret != ""})
	}
	return c.JSON(http.StatusOK, v)
}

// PutSettings handles PUT /api/v1/settings/auth (settings:auth:write).
func (h *Handler) PutSettings(c *echo.Context) error {
	if h.deps.Tenant == uuid.Nil {
		return echo.NewHTTPError(http.StatusConflict, "external sign-in needs a single workspace tenant (website_tenant_id)")
	}
	var m Methods
	if err := c.Bind(&m); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	ctx := c.Request().Context()
	roles, err := h.deps.Roles(ctx, h.deps.Tenant)
	if err != nil {
		return err
	}
	if err := m.Validate(func(id uuid.UUID) bool { return roles[id] }); err != nil {
		if errors.Is(err, ErrInvalidSettings) {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
		return err
	}
	if err := h.deps.Store.Save(ctx, h.deps.Tenant, m); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// PublicMethods handles GET /api/v1/auth/methods (anonymous): what the login
// screen shows. Any failure degrades to local only — never a lockout.
func (h *Handler) PublicMethods(c *echo.Context) error {
	m := Methods{}
	if h.deps.Tenant != uuid.Nil {
		if loaded, err := h.deps.Store.Load(c.Request().Context(), h.deps.Tenant); err == nil {
			m = loaded
		}
	}
	return c.JSON(http.StatusOK, m.Public())
}
