package version

import (
	"net/http"

	"github.com/labstack/echo/v5"
)

// Response is GET /api/v1/versions' body.
type Response struct {
	Services []Entry `json:"services"`
}

// Handler serves the registry's versions. Any signed-in staff user may read it
// (it backs the Settings dashboard), so it's mounted behind the JWT middleware
// only, not a permission.
func (r *Registry) Handler(c *echo.Context) error {
	return c.JSON(http.StatusOK, Response{Services: r.Collect(c.Request().Context())})
}
