package cron

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// historyStore is the call-site interface the handler needs — defined here,
// not at the implementation, per this codebase's convention (see e.g.
// internal/pictures/handler.go's pictureStore). *Repository (below) is the
// real implementation; tests stub it.
type historyStore interface {
	FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (CronHistory, error)
}

// Handler serves the ONE route this package hand-mounts: downloading a
// cron_history run's log file. Every other verb on cron/cron_history
// (list/get/create/update/delete) stays on the generic CRUD surface — this
// is the same "override only what needs it" posture crminheritdemo/
// warehouse/sale already take for a single extra action a table's normal
// CRUD shape has no room for.
type Handler struct {
	store historyStore
}

// NewHandler constructs the cron Handler from the concrete repository.
func NewHandler(store *Repository) *Handler {
	return &Handler{store: store}
}

// newHandlerWith constructs a Handler from an interface value (tests).
func newHandlerWith(store historyStore) *Handler {
	return &Handler{store: store}
}

// DownloadLog handles GET /api/v1/cron_history/:id/log — streams the run's
// captured log file. Derives cron_history:cron_history:read from the route
// (the "restore" pattern in derivePermissionFromRoute: a static segment
// after :id folds into the method, not a new resource), so no extra
// permission wiring is needed beyond what reading a cron_history row
// already requires.
func (h *Handler) DownloadLog(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id must be a UUID.")
	}

	history, err := h.store.FindInTenant(c.Request().Context(), identity.TenantID, id)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such cron history entry.")
		}
		return fmt.Errorf("cron: download log: find history: %w", err)
	}
	if history.LogsFilepath == "" {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "This run has no log file.")
	}

	file, err := os.Open(history.LogsFilepath)
	if err != nil {
		if os.IsNotExist(err) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "The log file is no longer available.")
		}
		return fmt.Errorf("cron: download log: open %s: %w", history.LogsFilepath, err)
	}
	defer func() { _ = file.Close() }()

	c.Response().Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(history.LogsFilepath)))
	return c.Stream(http.StatusOK, "text/plain; charset=utf-8", file)
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
