package devseed

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"

	"core/internal/auth"
	"core/internal/common"
	"core/internal/searchindex"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"go.uber.org/zap"
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
	notifier    Notifier
	// index runs after a successful seed (searchindex.Ensure in production).
	index func(context.Context, *orm.DB) ([]string, error)
	// mu serializes POST's "none running → start" so two concurrent requests
	// can't both start a seed for one tenant.
	mu sync.Mutex
}

// NewHandler seeds FullVolume rows; environment is Config.Environment — the
// endpoint refuses anything but "development". store is the picture service's
// object store, nil without s3_* (the seed then writes no pictures).
func NewHandler(db *orm.DB, store SampleStore, environment string, notifier Notifier) *Handler {
	return NewHandlerN(db, store, environment, notifier, FullVolume)
}

// NewHandlerN is NewHandler writing n rows per table (tests use a small n).
func NewHandlerN(db *orm.DB, store SampleStore, environment string, notifier Notifier, n int) *Handler {
	return &Handler{db: db, store: store, environment: environment, n: n, notifier: notifier, index: searchindex.Ensure}
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
	ctx := c.Request().Context()
	switch err := Validate(ctx, h.db, id.TenantID, req.Groups); {
	case errors.Is(err, ErrAlreadySeeded):
		return errorJSON(c, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, ErrUnknownGroup):
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
	case err != nil:
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if running, err := h.notifier.Repo().RunningActivity(ctx, id.TenantID, "dev_seed"); err != nil {
		return err
	} else if running != nil {
		return errorJSON(c, http.StatusConflict, "CONFLICT", "A demo data seed is already running for this workspace.")
	}
	notificationID, err := RunJob(ctx, h.notifier, id.TenantID, id.UserID, func(jobCtx context.Context, p Progress) ([]Result, error) {
		results, err := SeedWithProgress(jobCtx, h.db, h.store, id.TenantID, h.n, req.Groups, p)
		if err != nil {
			return results, err
		}
		// The seeded tables just crossed the search index policy's size floor:
		// index them now rather than at the next hourly pass, so searching the
		// demo volume is fast as soon as the seed ends. The policy reads planner
		// statistics, so only tables that already have fresh ones qualify here
		// (the seed ANALYZEs some of the tables it loads, not all); the rest
		// are indexed by the hourly pass once autovacuum has analyzed them. The
		// pass is skipped when the maintainer is already running one. Never a
		// seed failure: the maintainer retries on its own.
		p(99, "Building search indexes")
		if _, ierr := h.index(jobCtx, h.db); ierr != nil {
			common.Logger.Warn("devseed: search indexes", zap.Error(ierr))
		}
		return results, nil
	}, false)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusAccepted, map[string]any{"notification_id": notificationID})
}

// Groups handles GET /api/v1/dev_seed (dev_seed:dev_seed:read): the seed
// groups, their dependencies and whether this workspace already seeded them.
func (h *Handler) Groups(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	groups, err := Groups(c.Request().Context(), h.db, id.TenantID)
	if err != nil {
		return err
	}
	var running *uuid.UUID
	if n, err := h.notifier.Repo().RunningActivity(c.Request().Context(), id.TenantID, "dev_seed"); err != nil {
		return err
	} else if n != nil {
		running = &n.ID
	}
	return c.JSON(http.StatusOK, map[string]any{"data": groups, "running": running})
}
