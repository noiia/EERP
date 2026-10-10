package providers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"core/orm/access"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"go.uber.org/zap"
)

type Deps struct {
	Store  *Store
	Tenant uuid.UUID // auth tenant; uuid.Nil = only local login exists
	// Roles lists the tenant's role ids (validation of the mapping).
	Roles func(ctx context.Context, tenant uuid.UUID) (map[uuid.UUID]bool, error)

	Directory   Directory
	Provisioner *Provisioner
	Sessions    SessionIssuer
	OIDC        *OIDCClient
	Logger      *zap.Logger // nil = silent
}

// SessionIssuer opens the ERP session for an already-authenticated user
// (implemented by *auth.Handler).
type SessionIssuer interface {
	IssueSessionForUser(c *echo.Context, userID uuid.UUID) error
}

type Handler struct {
	deps Deps
	// provision is deps.Provisioner.Provision; a field so handler tests need no DB.
	provision func(ctx context.Context, tenant uuid.UUID, id ExternalIdentity, m Methods) (uuid.UUID, error)
}

func NewHandler(deps Deps) *Handler {
	if deps.Logger == nil {
		deps.Logger = zap.NewNop()
	}
	h := &Handler{deps: deps}
	if deps.Provisioner != nil {
		h.provision = deps.Provisioner.Provision
	}
	return h
}

// SetDirectory swaps the LDAP directory. Test-only: production wiring passes
// the directory through Deps.
func (h *Handler) SetDirectory(d Directory) { h.deps.Directory = d }

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

// guard resolves the auth tenant for an admin settings route: 409 when none is
// configured, 403 when the caller belongs to another tenant.
func (h *Handler) guard(c *echo.Context) error {
	if h.deps.Tenant == uuid.Nil {
		return echo.NewHTTPError(http.StatusConflict, "external sign-in needs a single workspace tenant (website_tenant_id)")
	}
	if t, ok := access.TenantFromContext(c.Request().Context()); !ok || t != h.deps.Tenant {
		return echo.NewHTTPError(http.StatusForbidden, "not the authentication tenant")
	}
	return nil
}

// GetSettings handles GET /api/v1/settings/auth (settings:auth:read).
func (h *Handler) GetSettings(c *echo.Context) error {
	if err := h.guard(c); err != nil {
		return err
	}
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
	if err := h.guard(c); err != nil {
		return err
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
		if errors.Is(err, ErrInvalidSettings) {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
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

func unauthorized(c *echo.Context, message string) error {
	return c.JSON(http.StatusUnauthorized, map[string]any{"error": map[string]string{
		"code": "UNAUTHENTICATED", "message": message, "request_id": c.Response().Header().Get(echo.HeaderXRequestID),
	}})
}

// LDAPLogin handles POST /api/v1/auth/ldap/login {username, password} (anonymous).
// Unknown user, several matches, wrong password and refused provisioning all
// answer the same 401; a directory outage is a logged 500.
func (h *Handler) LDAPLogin(c *echo.Context) error {
	const msg = "Invalid username or password."
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.Bind(&req); err != nil {
		return unauthorized(c, msg)
	}
	username := strings.TrimSpace(req.Username)
	if username == "" || req.Password == "" || h.deps.Tenant == uuid.Nil {
		return unauthorized(c, msg) // never reaches the directory (empty password = anonymous bind)
	}
	ctx := c.Request().Context()
	m, err := h.deps.Store.Load(ctx, h.deps.Tenant)
	if err != nil {
		return err
	}
	if m.LDAP == nil || !m.Allows("ldap") || h.deps.Directory == nil || h.provision == nil || h.deps.Sessions == nil {
		return unauthorized(c, msg)
	}
	id, err := h.deps.Directory.Authenticate(ctx, *m.LDAP, username, req.Password)
	if err != nil {
		if errors.Is(err, ErrInvalidCredentials) {
			h.deps.Logger.Debug("ldap sign-in: invalid credentials")
			return unauthorized(c, msg)
		}
		return fmt.Errorf("ldap login: %w", err) // directory down: a 500, logged
	}
	userID, err := h.provision(ctx, h.deps.Tenant, id, m)
	if err != nil {
		if errors.Is(err, ErrRefused) {
			h.deps.Logger.Info("external sign-in refused", zap.String("provider", "ldap"), zap.String("subject", id.Subject))
			return unauthorized(c, msg)
		}
		return err
	}
	return h.deps.Sessions.IssueSessionForUser(c, userID)
}

// TestSettings handles POST /api/v1/settings/auth/test {method} (settings:auth:write).
func (h *Handler) TestSettings(c *echo.Context) error {
	if err := h.guard(c); err != nil {
		return err
	}
	var req struct {
		Method string `json:"method"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	ctx := c.Request().Context()
	m, err := h.deps.Store.Load(ctx, h.deps.Tenant)
	if err != nil {
		return err
	}
	var testErr error
	switch {
	case req.Method == "ldap" && m.LDAP != nil && h.deps.Directory != nil:
		testErr = h.deps.Directory.Check(ctx, *m.LDAP)
	case strings.HasPrefix(req.Method, "oidc:") && h.deps.OIDC != nil:
		p, ok := m.Provider(strings.TrimPrefix(req.Method, "oidc:"))
		if !ok {
			return echo.NewHTTPError(http.StatusBadRequest, "unknown or unconfigured method")
		}
		testErr = h.deps.OIDC.Check(ctx, p)
	default:
		return echo.NewHTTPError(http.StatusBadRequest, "unknown or unconfigured method")
	}
	if testErr != nil {
		return c.JSON(http.StatusOK, map[string]any{"ok": false, "message": testErr.Error()})
	}
	return c.JSON(http.StatusOK, map[string]any{"ok": true, "message": "Connection succeeded."})
}

// OIDCAuthorize handles GET /api/v1/auth/oidc/providers/:id/authorize.
func (h *Handler) OIDCAuthorize(c *echo.Context) error {
	state, nonce, challenge := c.QueryParam("state"), c.QueryParam("nonce"), c.QueryParam("code_challenge")
	if state == "" || nonce == "" || challenge == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "state, nonce and code_challenge are required")
	}
	if h.deps.OIDC == nil {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	p, m, err := h.enabledProvider(c)
	if err != nil {
		return err
	}
	url, err := h.deps.OIDC.AuthorizeURL(c.Request().Context(), p, m.CallbackURL(), state, nonce, challenge)
	if err != nil {
		return fmt.Errorf("oidc authorize: %w", err)
	}
	return c.JSON(http.StatusOK, map[string]string{"url": url})
}

func (h *Handler) enabledProvider(c *echo.Context) (OIDCProvider, Methods, error) {
	notFound := echo.NewHTTPError(http.StatusNotFound, "not found")
	if h.deps.Tenant == uuid.Nil {
		return OIDCProvider{}, Methods{}, notFound
	}
	m, err := h.deps.Store.Load(c.Request().Context(), h.deps.Tenant)
	if err != nil {
		return OIDCProvider{}, Methods{}, err
	}
	id := c.Param("id")
	p, ok := m.Provider(id)
	if !ok || !m.Allows("oidc:"+id) {
		return OIDCProvider{}, Methods{}, notFound
	}
	return p, m, nil
}

// OIDCExchange handles POST /api/v1/auth/oidc/providers/:id/exchange.
func (h *Handler) OIDCExchange(c *echo.Context) error {
	const msg = "Sign-in failed."
	var req struct {
		Code         string `json:"code"`
		CodeVerifier string `json:"code_verifier"`
		Nonce        string `json:"nonce"`
	}
	if err := c.Bind(&req); err != nil || req.Code == "" || req.CodeVerifier == "" || req.Nonce == "" {
		return unauthorized(c, msg)
	}
	if h.deps.OIDC == nil || h.provision == nil || h.deps.Sessions == nil {
		return unauthorized(c, msg)
	}
	p, m, err := h.enabledProvider(c)
	if err != nil {
		return unauthorized(c, msg)
	}
	ctx := c.Request().Context()
	id, err := h.deps.OIDC.Exchange(ctx, p, req.Code, req.CodeVerifier, m.CallbackURL(), req.Nonce)
	if err != nil {
		if errors.Is(err, ErrOIDC) {
			h.deps.Logger.Warn("oidc sign-in rejected", zap.String("provider", "oidc:"+p.ID), zap.Error(err))
			return unauthorized(c, msg)
		}
		return fmt.Errorf("oidc exchange: %w", err)
	}
	userID, err := h.provision(ctx, h.deps.Tenant, id, m)
	if err != nil {
		if errors.Is(err, ErrRefused) {
			h.deps.Logger.Info("external sign-in refused", zap.String("provider", id.Provider), zap.String("subject", id.Subject))
			return unauthorized(c, msg)
		}
		return err
	}
	return h.deps.Sessions.IssueSessionForUser(c, userID)
}
