package mail

import (
	"encoding/json"
	"errors"
	"net/http"

	"core/orm"
	"core/orm/access"

	"github.com/labstack/echo/v5"
)

// TemplateHandler serves Settings → Email templates:
// GET /api/v1/settings/mail_templates (settings:mail_templates:read) and
// PUT|DELETE /api/v1/settings/mail_templates/:key/:locale (…:write|delete),
// tenant-pinned. A DELETE reverts (key, locale) to its default.
type TemplateHandler struct{ db *orm.DB }

func NewTemplateHandler(db *orm.DB) *TemplateHandler { return &TemplateHandler{db: db} }

type templateRow struct {
	TemplateDef
	Overrides map[string]Content `json:"overrides"`
}

func (h *TemplateHandler) List(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, ok := access.TenantFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	stored, err := Overrides(ctx, h.db, tenant)
	if err != nil {
		return err
	}
	data := []templateRow{}
	for _, def := range Templates() {
		o := stored[def.Key]
		if o == nil {
			o = map[string]Content{}
		}
		data = append(data, templateRow{TemplateDef: def, Overrides: o})
	}
	return c.JSON(http.StatusOK, map[string]any{"data": data})
}

func (h *TemplateHandler) Put(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, ok := access.TenantFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	var in Content
	if err := json.NewDecoder(c.Request().Body).Decode(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	err := SaveTemplate(ctx, h.db, tenant, c.Param("key"), c.Param("locale"), in.Subject, in.HTML)
	switch {
	case errors.Is(err, ErrUnknownTemplate):
		return echo.NewHTTPError(http.StatusNotFound, "no such template")
	case errors.Is(err, ErrInvalidTemplate):
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	case err != nil:
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *TemplateHandler) Delete(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, ok := access.TenantFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	if _, known := lookupDef(c.Param("key")); !known {
		return echo.NewHTTPError(http.StatusNotFound, "no such template")
	}
	if err := DeleteTemplate(ctx, h.db, tenant, c.Param("key"), c.Param("locale")); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}
