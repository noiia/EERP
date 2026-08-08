package reports

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"core/internal/auth"
	"core/internal/pictures"

	"github.com/labstack/echo/v4"
)

// printTokenTTL is how long the signed token embedded in a print URL stays
// valid — long enough for pdf-service to navigate and print, short enough
// that a logged or leaked URL isn't a standing session credential
// (docs/adr/ADR-010's "short-lived signed token" decision).
const printTokenTTL = 60 * time.Second

// permissionSource is the call-site interface the handler needs from the
// permission repository — *auth.PermissionRepository satisfies it.
type permissionSource interface {
	Has(ctx context.Context, roles []string, required string) (bool, error)
	ForRoles(ctx context.Context, roles []string) ([]string, error)
}

// tokenIssuer is the call-site interface the handler needs to mint the
// print URL's token — *auth.TokenService satisfies it.
type tokenIssuer interface {
	IssueAccessWithTTL(user auth.Users, roles []string, permissions []string, ttl time.Duration) (string, error)
}

type Handler struct {
	renderer     PDFRenderer
	objects      pictures.ObjectStore
	tokens       tokenIssuer
	permissions  permissionSource
	frontendBase string
}

// NewHandler constructs the reports Handler. frontendBase is core-front's
// internal address (e.g. http://core-front:3000) — Go otherwise has no
// reason to know it, since every OTHER data flow goes frontend-to-backend.
func NewHandler(renderer PDFRenderer, objects pictures.ObjectStore, tokens tokenIssuer, permissions permissionSource, frontendBase string) *Handler {
	return &Handler{
		renderer:     renderer,
		objects:      objects,
		tokens:       tokens,
		permissions:  permissions,
		frontendBase: strings.TrimSuffix(frontendBase, "/"),
	}
}

// GeneratePDF handles POST /api/v1/reports/:name/:id/pdf.
//
// Mounted behind jwtMw ONLY (main.go) — deliberately NOT the generic
// PermissionMiddleware. :name sits immediately after the route's first
// static segment ("reports"), so PermissionMiddleware's route-pattern-only
// derivation would see just that one segment and yield the coarse
// "reports:reports:write", never a report-specific permission — it has no
// way to see :name's RUNTIME value, only the compiled Echo pattern. The
// fine-grained report:<name>:read check happens here instead, against the
// actual requested report.
func (h *Handler) GeneratePDF(c echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)
	name := c.Param("name")
	recordID := c.Param("id")
	if name == "" || recordID == "" {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "name and id are required.")
	}

	required := "report:" + name + ":read"
	allowed, err := h.permissions.Has(ctx, identity.Roles, required)
	if err != nil {
		return fmt.Errorf("reports: check permission: %w", err)
	}
	if !allowed {
		return errorJSON(c, http.StatusForbidden, "FORBIDDEN", "Insufficient permissions.")
	}

	// Re-derive permissions from the DB — never trust a caller-supplied claim —
	// to embed in the short-lived token, exactly what Login/Refresh already do
	// for a full session token, just at a much shorter TTL.
	perms, err := h.permissions.ForRoles(ctx, identity.Roles)
	if err != nil {
		return fmt.Errorf("reports: resolve permissions: %w", err)
	}
	user := auth.Users{TenantID: identity.TenantID}
	user.ID = identity.UserID
	token, err := h.tokens.IssueAccessWithTTL(user, identity.Roles, perms, printTokenTTL)
	if err != nil {
		return fmt.Errorf("reports: issue print token: %w", err)
	}

	printURL := fmt.Sprintf("%s/print/report/%s/%s?token=%s",
		h.frontendBase, url.PathEscape(name), url.PathEscape(recordID), url.QueryEscape(token))

	pdf, err := h.renderer.Render(ctx, printURL)
	if err != nil {
		return errorJSON(c, http.StatusBadGateway, "RENDER_FAILED", "Could not generate the report.")
	}

	key := fmt.Sprintf("reports/%s/%s/%s/%d.pdf", identity.TenantID, name, recordID, time.Now().UTC().Unix())
	if err := h.objects.Put(ctx, key, "application/pdf", int64(len(pdf)), bytes.NewReader(pdf)); err != nil {
		return fmt.Errorf("reports: store pdf: %w", err)
	}

	return c.JSON(http.StatusCreated, map[string]string{
		"download_url": "/api/v1/reports/pdf?key=" + url.QueryEscape(key),
	})
}

// DownloadPDF handles GET /api/v1/reports/pdf?key=... — streams a
// previously generated report back. Mounted behind jwtMw + permMw: this is
// a flat route with no path params, so PermissionMiddleware correctly
// derives reports:pdf:read from it. The fine-grained report:<name>:read
// check already happened once, at generation time — downloading an object
// you hold the key to needs only tenant membership plus this coarser read
// grant, the same posture internal/pictures' Get takes (it doesn't re-check
// the anchor's own write permission either).
func (h *Handler) DownloadPDF(c echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)

	key := c.QueryParam("key")
	tenantPrefix := "reports/" + identity.TenantID.String() + "/"
	if key == "" || !strings.HasPrefix(key, tenantPrefix) {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such report.")
	}

	body, contentType, err := h.objects.Get(ctx, key)
	if err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such report.")
	}
	defer func() { _ = body.Close() }()
	if contentType == "" {
		contentType = "application/pdf"
	}
	return c.Stream(http.StatusOK, contentType, body)
}

func errorJSON(c echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    msg,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}
