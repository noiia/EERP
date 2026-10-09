package devseed

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/labstack/echo/v5"
)

// FullVolume is how many rows the full volume writes per business table.
const FullVolume = 100_000

// Handler serves GET|POST /api/v1/dev_seed (permissions
// dev_seed:dev_seed:read|write, derived from the route).
type Handler struct {
	db          *orm.DB
	store       SampleStore
	environment string
	n           int
}

// NewHandler seeds FullVolume rows; environment is Config.Environment — the
// endpoint refuses anything but "development". store is the picture service's
// object store, nil without s3_* (the seed then writes no pictures).
func NewHandler(db *orm.DB, store SampleStore, environment string) *Handler {
	return &Handler{db: db, store: store, environment: environment, n: FullVolume}
}

type seedResponse struct {
	Results []Result `json:"results"`
	Seconds float64  `json:"seconds"`
}

func errorJSON(c *echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

// seedRequest selects the groups to seed (absent or empty = every group).
type seedRequest struct {
	Groups []string `json:"groups"`
}

// Seed handles POST /api/v1/dev_seed {groups?}: the selected groups (plus
// their dependencies) not seeded yet, into the caller's tenant. 409 when all
// of them already were; 400 for an unknown group.
func (h *Handler) Seed(c *echo.Context) error {
	if h.environment != "development" {
		return errorJSON(c, http.StatusForbidden, "FORBIDDEN", "Demo data seeding is only available in development.")
	}
	var req seedRequest
	if c.Request().ContentLength != 0 {
		if err := json.NewDecoder(c.Request().Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
		}
	}
	id := auth.MustIdentity(c.Request().Context())
	start := time.Now()
	results, err := Seed(c.Request().Context(), h.db, h.store, id.TenantID, h.n, req.Groups)
	switch {
	case errors.Is(err, ErrAlreadySeeded):
		return errorJSON(c, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, ErrUnknownGroup):
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
	case err != nil:
		return err
	}
	return c.JSON(http.StatusOK, seedResponse{Results: results, Seconds: time.Since(start).Seconds()})
}

// Groups handles GET /api/v1/dev_seed (dev_seed:dev_seed:read): the seed
// groups, their dependencies and whether this workspace already seeded them.
func (h *Handler) Groups(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	groups, err := Groups(c.Request().Context(), h.db, id.TenantID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"data": groups})
}
