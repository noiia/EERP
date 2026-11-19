package website

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// RoutingKey stores how the site and the ERP share hostnames.
const RoutingKey = "website.routing"

// Routing: "path" (default) — site at /, ERP at /app, any host; "host" — the
// site on SiteHost, the ERP on ERPHost (see core-front src/lib/routing.ts).
type Routing struct {
	Mode     string `json:"mode"`
	SiteHost string `json:"site_host"`
	ERPHost  string `json:"erp_host"`
}

var hostPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`)

var errRouting = errors.New("invalid routing")

// validateRouting refuses host mode unless the save itself arrived through
// ERPHost — proof that name already resolves here, so the admin can't lock
// themselves out of the ERP by saving a typo.
func validateRouting(r Routing, requestHost string) error {
	switch r.Mode {
	case "path":
		return nil
	case "host":
	default:
		return fmt.Errorf("%w: mode must be path or host", errRouting)
	}
	if !hostPattern.MatchString(r.SiteHost) || !hostPattern.MatchString(r.ERPHost) {
		return fmt.Errorf("%w: site_host and erp_host must be bare host names", errRouting)
	}
	if r.SiteHost == r.ERPHost {
		return fmt.Errorf("%w: site_host and erp_host must differ", errRouting)
	}
	if h, _, err := net.SplitHostPort(requestHost); err == nil {
		requestHost = h
	}
	if !strings.EqualFold(requestHost, r.ERPHost) {
		return fmt.Errorf("%w: open the ERP through https://%s/ and save from there, so a mistyped host can't lock you out", errRouting, r.ERPHost)
	}
	return nil
}

type RoutingHandler struct {
	store      SettingsStore
	siteTenant uuid.UUID
}

func NewRoutingHandler(store SettingsStore, siteTenant uuid.UUID) *RoutingHandler {
	return &RoutingHandler{store: store, siteTenant: siteTenant}
}

func (h *RoutingHandler) load(ctx context.Context, tenant uuid.UUID) (Routing, error) {
	raw, found, err := h.store.Get(ctx, tenant, uuid.Nil, RoutingKey)
	if err != nil {
		return Routing{}, err
	}
	r := Routing{Mode: "path"}
	if found && raw != "" {
		_ = json.Unmarshal([]byte(raw), &r) // unparsable degrades to path mode
	}
	return r, nil
}

// Get handles GET /api/v1/settings/website/routing.
func (h *RoutingHandler) Get(c *echo.Context) error {
	ctx := c.Request().Context()
	r, err := h.load(ctx, auth.MustIdentity(ctx).TenantID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, r)
}

// Put handles PUT /api/v1/settings/website/routing.
func (h *RoutingHandler) Put(c *echo.Context) error {
	var r Routing
	if err := c.Bind(&r); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	r.SiteHost, r.ERPHost = strings.ToLower(strings.TrimSpace(r.SiteHost)), strings.ToLower(strings.TrimSpace(r.ERPHost))
	host := c.Request().Header.Get("X-EERP-Request-Host")
	if host == "" {
		host = c.Request().Host
	}
	if err := validateRouting(r, host); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	raw, _ := json.Marshal(r)
	ctx := c.Request().Context()
	if err := h.store.Set(ctx, auth.MustIdentity(ctx).TenantID, uuid.Nil, RoutingKey, string(raw)); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// PublicSite handles GET /api/v1/public/site — what the Next proxy needs to
// route a request, readable anonymously.
func (h *RoutingHandler) PublicSite(c *echo.Context) error {
	r, err := h.load(c.Request().Context(), h.siteTenant)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"routing": r})
}
