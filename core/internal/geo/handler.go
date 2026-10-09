// Package geo serves the distance between two records' geographic values
// (ADR-029). The ORM resolves and authorizes both references; this is HTTP.
package geo

import (
	"errors"
	"net/http"

	"core/orm"

	"github.com/labstack/echo/v5"
)

type Handler struct{ db orm.Executor }

func NewHandler(db orm.Executor) *Handler { return &Handler{db: db} }

// Distance handles GET /api/v1/geo/distance?from=<table>:<id>:<col>&to=...
// and answers {"meters": n|null}. Permission geo:distance:read (route-derived),
// plus read access to both referenced tables.
func (h *Handler) Distance(c *echo.Context) error {
	meters, err := orm.GeoDistance(c.Request().Context(), h.db, c.QueryParam("from"), c.QueryParam("to"))
	switch {
	case errors.Is(err, orm.ErrGeoParam):
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	case errors.Is(err, orm.ErrGeoRef):
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	case err != nil:
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"meters": meters})
}
