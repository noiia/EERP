package devseed

import (
	"errors"
	"net/http"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/labstack/echo/v5"
)

// FullVolume is how many rows the full volume writes per business table.
const FullVolume = 100_000

// Handler serves POST /api/v1/dev_seed (permission dev_seed:dev_seed:write,
// derived from the route).
type Handler struct {
	db          *orm.DB
	environment string
	n           int
}

// NewHandler seeds FullVolume rows; environment is Config.Environment — the
// endpoint refuses anything but "development".
func NewHandler(db *orm.DB, environment string) *Handler {
	return &Handler{db: db, environment: environment, n: FullVolume}
}

type seedResponse struct {
	Results []Result `json:"results"`
	Seconds float64  `json:"seconds"`
}

func errorJSON(c *echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

// Seed writes the full demo volume into the caller's tenant.
func (h *Handler) Seed(c *echo.Context) error {
	if h.environment != "development" {
		return errorJSON(c, http.StatusForbidden, "FORBIDDEN", "Demo data seeding is only available in development.")
	}
	id := auth.MustIdentity(c.Request().Context())
	start := time.Now()
	results, err := Seed(c.Request().Context(), h.db, id.TenantID, h.n)
	if errors.Is(err, ErrAlreadySeeded) {
		return errorJSON(c, http.StatusConflict, "CONFLICT", err.Error())
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, seedResponse{Results: results, Seconds: time.Since(start).Seconds()})
}
