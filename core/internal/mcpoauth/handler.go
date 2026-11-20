package mcpoauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"core/internal/auth"
	"core/internal/common"
	ormserver "core/orm/server"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"go.uber.org/zap"
)

const (
	codeTTL = 2 * time.Minute
	// mcpAccessTTL caps an MCP access token's life; a revoked grant also ends it
	// at once through the gid check on every MCP request.
	mcpAccessTTL = time.Hour
	scope        = "mcp"
)

// pkce is a base64url S256 challenge or an RFC 7636 verifier (43–128 unreserved characters).
var pkce = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)

type userSource interface {
	FindByID(ctx context.Context, id uuid.UUID) (auth.Users, error)
	FindRoleNames(ctx context.Context, userID uuid.UUID) ([]string, error)
	FindGroups(ctx context.Context, userID uuid.UUID) ([]string, error)
}

type permissionSource interface {
	ForRoles(ctx context.Context, roles []string) ([]string, error)
}

// Handler serves the OAuth endpoints.
type Handler struct {
	s          Settings
	store      *Store
	clients    *resolver
	tokens     *auth.TokenService
	users      userSource
	perms      permissionSource
	refreshTTL time.Duration
	accessTTL  time.Duration
}

// NewHandler wires the OAuth server. refreshTTL and accessTTL are the ERP's
// session lengths; an MCP access token lives at most an hour.
func NewHandler(s Settings, store *Store, tokens *auth.TokenService, users userSource, perms permissionSource, accessTTL, refreshTTL time.Duration) *Handler {
	return &Handler{s: s, store: store, clients: newResolver(s, store, publicHTTPClient()), tokens: tokens,
		users: users, perms: perms, accessTTL: min(accessTTL, mcpAccessTTL), refreshTTL: refreshTTL}
}

// GrantLive is the MCP endpoint's revocation check (see mcpbridge.UseOAuth).
func (h *Handler) GrantLive(ctx context.Context, grant, user uuid.UUID) (bool, error) {
	return h.store.GrantLive(ctx, grant, user)
}

// Mount registers the routes. jwt guards the user's own pages (consent, grants).
// The calls a client's servers make (discovery, registration, token) share
// clientLimit per IP: every user of one AI service arrives from its IPs. The
// consent calls come from the user and take the sign-in limit.
func (h *Handler) Mount(e *echo.Echo, jwt echo.MiddlewareFunc, clientLimit, userLimit int) {
	clientRate, userRate := ormserver.AuthRateLimiter(clientLimit), ormserver.AuthRateLimiter(userLimit)
	// Next relays /.well-known/* to the API paths (app/.well-known/*); the root
	// paths answer too, for a gateway that routes them straight here.
	for _, p := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource" + MCPPath,
		"/api/v1/oauth/metadata/protected-resource"} {
		e.GET(p, h.ProtectedResource, clientRate)
	}
	for _, p := range []string{"/.well-known/oauth-authorization-server", "/api/v1/oauth/metadata/authorization-server"} {
		e.GET(p, h.AuthorizationServer, clientRate)
	}
	e.POST("/api/v1/oauth/register", h.Register, ormserver.BodyLimit("64K"), clientRate)
	e.POST("/api/v1/oauth/token", h.Token, ormserver.BodyLimit("64K"), clientRate)
	e.GET("/api/v1/oauth/authorize", h.Check, userRate, jwt)
	e.POST("/api/v1/oauth/authorize", h.Decide, ormserver.BodyLimit("64K"), userRate, jwt)
	e.GET("/api/v1/oauth/grants", h.ListGrants, jwt)
	e.DELETE("/api/v1/oauth/grants/:id", h.RevokeGrant, jwt)
}

// ── Discovery ────────────────────────────────────────────────────────────────

// ProtectedResource is RFC 9728 metadata: which server issues tokens for MCP.
func (h *Handler) ProtectedResource(c *echo.Context) error {
	return c.JSON(http.StatusOK, map[string]any{
		"resource":                 h.s.Resource(),
		"authorization_servers":    []string{h.s.Issuer},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{scope},
		"resource_name":            "EERP",
	})
}

// AuthorizationServer is RFC 8414 metadata. CIMD needs both
// client_id_metadata_document_supported and the "none" auth method.
func (h *Handler) AuthorizationServer(c *echo.Context) error {
	return c.JSON(http.StatusOK, map[string]any{
		"issuer":                                         h.s.Issuer,
		"authorization_endpoint":                         h.s.Issuer + "/app/oauth/authorize",
		"token_endpoint":                                 h.s.Issuer + "/api/v1/oauth/token",
		"registration_endpoint":                          h.s.Issuer + "/api/v1/oauth/register",
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"client_id_metadata_document_supported":          true,
		"scopes_supported":                               []string{scope},
		"authorization_response_iss_parameter_supported": true,
	})
}

// ── Registration (RFC 7591) ──────────────────────────────────────────────────

// Register creates a public client. Only redirect URIs on trusted hosts are
// accepted, so a registration can only ever send codes back to those hosts.
func (h *Handler) Register(c *echo.Context) error {
	var body struct {
		RedirectURIs []string `json:"redirect_uris"`
		ClientName   string   `json:"client_name"`
	}
	if err := c.Bind(&body); err != nil {
		return oauthError(c, http.StatusBadRequest, "invalid_client_metadata", "malformed registration request")
	}
	if err := h.clients.checkRedirectURIs(body.RedirectURIs); err != nil {
		return oauthError(c, http.StatusBadRequest, "invalid_redirect_uri", err.Error())
	}
	// Every client is registered public (token_endpoint_auth_method none, PKCE): RFC 7591
	// lets the server answer with other values than requested, and the response says so.
	// Grant types it doesn't serve (jwt-bearer…) are left out the same way.
	host, _ := url.Parse(body.RedirectURIs[0])
	client, err := h.store.RegisterClient(c.Request().Context(), clientName(body.ClientName, host.Hostname()), body.RedirectURIs)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, map[string]any{
		"client_id":                  client.ClientID,
		"client_id_issued_at":        client.CreatedAt.Unix(),
		"client_name":                client.Name,
		"redirect_uris":              body.RedirectURIs,
		"token_endpoint_auth_method": "none",
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
	})
}

// ── Authorization ────────────────────────────────────────────────────────────

// authRequest is the validated authorization request.
type authRequest struct {
	client      ClientInfo
	redirectURI string
	challenge   string
	state       string
}

// authError is a refused authorization request. redirect is set once the
// redirect URI is known good: only then may the error go back to the client.
type authError struct {
	code, description, redirect string
}

func (h *Handler) validate(ctx context.Context, q url.Values) (authRequest, *authError) {
	clientID, redirectURI := q.Get("client_id"), q.Get("redirect_uri")
	if clientID == "" || redirectURI == "" {
		return authRequest{}, &authError{code: "invalid_request", description: "client_id and redirect_uri are required"}
	}
	client, err := h.clients.resolve(ctx, clientID)
	if err != nil {
		if common.Logger != nil && !errors.Is(err, errUnknownClient) {
			common.Logger.Info("mcp oauth: client refused", zap.String("client_id", clientID), zap.Error(err))
		}
		return authRequest{}, &authError{code: "invalid_client", description: "This application is not allowed to connect to EERP."}
	}
	if !redirectAllowed(client.RedirectURIs, redirectURI) {
		return authRequest{}, &authError{code: "invalid_request", description: "redirect_uri is not registered for this application"}
	}
	r := authRequest{client: client, redirectURI: redirectURI, challenge: q.Get("code_challenge"), state: q.Get("state")}
	fail := func(code, desc string) (authRequest, *authError) {
		return authRequest{}, &authError{code: code, description: desc, redirect: h.errorRedirect(r, code, desc)}
	}
	switch {
	case q.Get("response_type") != "code":
		return fail("unsupported_response_type", "response_type must be code")
	case q.Get("code_challenge_method") != "S256" || !pkce.MatchString(r.challenge):
		return fail("invalid_request", "PKCE with code_challenge_method S256 is required")
	case !h.resourceOK(q.Get("resource")):
		return fail("invalid_target", "resource must be "+h.s.Resource())
	}
	return r, nil
}

// resourceOK accepts no resource (the MCP endpoint is the only one) or this server's MCP URL.
func (h *Handler) resourceOK(resource string) bool {
	return resource == "" || strings.TrimSuffix(resource, "/") == h.s.Resource()
}

func (h *Handler) errorRedirect(r authRequest, code, desc string) string {
	return h.redirect(r, url.Values{"error": {code}, "error_description": {desc}})
}

func (h *Handler) redirect(r authRequest, v url.Values) string {
	if r.state != "" {
		v.Set("state", r.state)
	}
	v.Set("iss", h.s.Issuer)
	sep := "?"
	if strings.Contains(r.redirectURI, "?") {
		sep = "&"
	}
	return r.redirectURI + sep + v.Encode()
}

// Check serves GET /api/v1/oauth/authorize (the consent page's read): the
// client the user is about to approve, or why the request is refused (ok=false).
func (h *Handler) Check(c *echo.Context) error {
	r, aerr := h.validate(c.Request().Context(), c.QueryParams())
	if aerr != nil {
		return authErrorJSON(c, aerr)
	}
	return c.JSON(http.StatusOK, map[string]any{
		"ok":           true,
		"client_id":    r.client.ID,
		"client_name":  r.client.Name,
		"client_host":  r.client.Host,
		"redirect_uri": r.redirectURI,
		"resource":     h.s.Resource(),
	})
}

// Decide serves POST /api/v1/oauth/authorize {params, approve}: the user's
// answer. It returns where to send the browser: the client's redirect URI with a
// code, or with error=access_denied.
func (h *Handler) Decide(c *echo.Context) error {
	var body struct {
		Params  map[string]string `json:"params"`
		Approve bool              `json:"approve"`
	}
	if err := c.Bind(&body); err != nil {
		return authErrorJSON(c, &authError{code: "invalid_request", description: "malformed request"})
	}
	q := url.Values{}
	for k, v := range body.Params {
		q.Set(k, v)
	}
	ctx := c.Request().Context()
	r, aerr := h.validate(ctx, q)
	if aerr != nil {
		return authErrorJSON(c, aerr)
	}
	if !body.Approve {
		return c.JSON(http.StatusOK, map[string]any{"ok": true, "redirect_to": h.errorRedirect(r, "access_denied", "The user declined.")})
	}
	id := auth.MustIdentity(ctx)
	if id.MustChangePassword {
		return authErrorJSON(c, &authError{code: "access_denied", description: "Change your password in EERP first."})
	}
	code, err := h.store.CreateCode(ctx, Code{TenantID: id.TenantID, UserID: id.UserID, ClientID: r.client.ID,
		ClientName: r.client.Name, RedirectURI: r.redirectURI, Challenge: r.challenge, ExpiresAt: time.Now().Add(codeTTL)})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"ok": true, "redirect_to": h.redirect(r, url.Values{"code": {code}})})
}

// authErrorJSON answers a refused authorization request. The consent page is the
// only caller and needs the error's details (and where it may go back to), which
// a non-2xx answer would lose in the BFF's error handling: so it's a 200 with
// ok=false, never an OAuth protocol response.
func authErrorJSON(c *echo.Context, e *authError) error {
	out := map[string]any{"ok": false, "error": e.code, "error_description": e.description}
	if e.redirect != "" {
		out["redirect_to"] = e.redirect
	}
	return c.JSON(http.StatusOK, out)
}

// ── Token ────────────────────────────────────────────────────────────────────

// Token serves POST /api/v1/oauth/token (form-encoded): the authorization_code
// and refresh_token grants, both for public clients.
func (h *Handler) Token(c *echo.Context) error {
	c.Response().Header().Set("Cache-Control", "no-store")
	c.Response().Header().Set("Pragma", "no-cache")
	ctx := c.Request().Context()
	clientID := c.FormValue("client_id")
	if clientID == "" {
		return oauthError(c, http.StatusUnauthorized, "invalid_client", "client_id is required")
	}
	if !h.resourceOK(c.FormValue("resource")) {
		return oauthError(c, http.StatusBadRequest, "invalid_target", "resource must be "+h.s.Resource())
	}
	switch c.FormValue("grant_type") {
	case "authorization_code":
		redirectURI, verifier := c.FormValue("redirect_uri"), c.FormValue("code_verifier")
		code, grant, refresh, err := h.store.ExchangeCode(ctx, c.FormValue("code"), func(code Code) error {
			if code.ClientID != clientID || code.RedirectURI != redirectURI || !pkce.MatchString(verifier) || !challengeMatches(code.Challenge, verifier) {
				return errInvalidGrant
			}
			_, err := h.liveUser(ctx, code.UserID, code.TenantID)
			return err
		}, func(code Code) Grant {
			return Grant{TenantID: code.TenantID, UserID: code.UserID, ClientID: code.ClientID, ClientName: code.ClientName,
				ExpiresAt: time.Now().Add(h.refreshTTL)}
		})
		if err != nil {
			return h.grantError(c, err)
		}
		return h.issue(c, code.UserID, code.TenantID, grant.ID, refresh)
	case "refresh_token":
		grant, refresh, err := h.store.RotateRefresh(ctx, c.FormValue("refresh_token"), clientID, h.refreshTTL)
		if err != nil {
			return h.grantError(c, err)
		}
		if _, err := h.liveUser(ctx, grant.UserID, grant.TenantID); err != nil {
			return h.grantError(c, err)
		}
		return h.issue(c, grant.UserID, grant.TenantID, grant.ID, refresh)
	default:
		return oauthError(c, http.StatusBadRequest, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token")
	}
}

func challengeMatches(challenge, verifier string) bool {
	sum := sha256.Sum256([]byte(verifier))
	return subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

// liveUser is the grant's user while they may still use EERP: a live staff
// account of the grant's tenant. Anything else ends the grant's usefulness.
func (h *Handler) liveUser(ctx context.Context, id, tenant uuid.UUID) (auth.Users, error) {
	u, err := h.users.FindByID(ctx, id)
	if err != nil || u.DeletedAt != nil || u.IsWebsite() || u.TenantID != tenant {
		return auth.Users{}, errInvalidGrant
	}
	return u, nil
}

func (h *Handler) grantError(c *echo.Context, err error) error {
	if errors.Is(err, errInvalidGrant) {
		return oauthError(c, http.StatusBadRequest, "invalid_grant", "the code or refresh token is invalid, expired or revoked")
	}
	return err
}

// issue mints the access token from the user's current roles, like an ERP refresh does.
func (h *Handler) issue(c *echo.Context, userID, tenant, grant uuid.UUID, refresh string) error {
	ctx := c.Request().Context()
	user, err := h.liveUser(ctx, userID, tenant)
	if err != nil {
		return h.grantError(c, err)
	}
	roles, err := h.users.FindRoleNames(ctx, user.ID)
	if err != nil {
		return err
	}
	groups, err := h.users.FindGroups(ctx, user.ID)
	if err != nil {
		return err
	}
	perms, err := h.perms.ForRoles(ctx, roles)
	if err != nil {
		return err
	}
	access, err := h.tokens.IssueMCPAccess(user, roles, groups, perms, grant, h.accessTTL)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(h.accessTTL.Seconds()),
		"refresh_token": refresh,
		"scope":         scope,
	})
}

func oauthError(c *echo.Context, status int, code, desc string) error {
	return c.JSON(status, map[string]string{"error": code, "error_description": desc})
}

// ── The user's authorized apps ───────────────────────────────────────────────

func (h *Handler) ListGrants(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	rows, err := h.store.Grants(c.Request().Context(), id.TenantID, id.UserID)
	if err != nil {
		return err
	}
	out := make([]map[string]any, len(rows))
	for i, g := range rows {
		out[i] = map[string]any{"id": g.ID, "client_name": g.ClientName, "client_id": g.ClientID,
			"created_at": g.CreatedAt, "last_used_at": g.LastUsedAt}
	}
	return c.JSON(http.StatusOK, map[string]any{"data": out})
}

func (h *Handler) RevokeGrant(c *echo.Context) error {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	grant, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]any{"error": map[string]string{"code": "NOT_FOUND", "message": "No such authorized app."}})
	}
	ok, err := h.store.RevokeGrant(ctx, id.TenantID, id.UserID, grant)
	if err != nil {
		return err
	}
	if !ok {
		return c.JSON(http.StatusNotFound, map[string]any{"error": map[string]string{"code": "NOT_FOUND", "message": "No such authorized app."}})
	}
	return c.NoContent(http.StatusNoContent)
}
