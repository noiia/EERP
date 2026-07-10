package module

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/labstack/echo/v4"
)

// Handler serves the dedicated module-management endpoints backing the App
// Store (docs/roadmaps/app-store.md, Phase 1): GET (list, generic envelope),
// GET /:id, PUT /:id. Never tenant-scoped — modules are workspace-wide, not
// per-tenant data — so, unlike pictures/notebook, there is no
// auth.MustIdentity here. Mounted behind jwtMw + permMw; the permission
// middleware derives modules:modules:read|write from the route.

// moduleStore is the call-site interface the handler needs from the manager.
type moduleStore interface {
	List(ctx context.Context) ([]map[string]any, error)
	Get(ctx context.Context, id string) (map[string]any, error)
	Patch(ctx context.Context, id string, changes map[string]any) (map[string]any, error)
}

type Handler struct {
	store moduleStore
}

// NewHandler constructs the modules Handler from the concrete Manager.
func NewHandler(store *Manager) *Handler {
	return &Handler{store: store}
}

// newHandlerWith constructs a Handler from an interface value (tests).
func newHandlerWith(store moduleStore) *Handler {
	return &Handler{store: store}
}

// listEnvelope mirrors the generic CRUD list shape ({data, total}) so the
// frontend's ApiClient consumes this virtual entity exactly like any other.
type listEnvelope struct {
	Data  []map[string]any `json:"data"`
	Total int              `json:"total"`
}

// List handles GET /api/v1/modules.
func (h *Handler) List(c echo.Context) error {
	records, err := h.store.List(c.Request().Context())
	if err != nil {
		return fmt.Errorf("modules: list: %w", err)
	}
	return c.JSON(http.StatusOK, listEnvelope{Data: records, Total: len(records)})
}

// Get handles GET /api/v1/modules/:id.
func (h *Handler) Get(c echo.Context) error {
	record, err := h.store.Get(c.Request().Context(), c.Param("id"))
	if err != nil {
		if errors.Is(err, ErrModuleNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such module.")
		}
		return fmt.Errorf("modules: get: %w", err)
	}
	return c.JSON(http.StatusOK, record)
}

// Update handles PUT /api/v1/modules/:id. The only field the body may carry
// is "active" (boolean) — Manager.Patch whitelists and fails closed on
// anything else. Every successful response adds requires_restart: true
// (docs/roadmaps/app-store.md, decision #5): the change is on disk
// immediately, live only after the next backend restart + frontend rebuild.
func (h *Handler) Update(c echo.Context) error {
	var changes map[string]any
	if err := json.NewDecoder(c.Request().Body).Decode(&changes); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}

	updated, err := h.store.Patch(c.Request().Context(), c.Param("id"), changes)
	if err != nil {
		var verr *ValidationError
		switch {
		case errors.As(err, &verr):
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", verr.Message)
		case errors.Is(err, ErrModuleNotFound):
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such module.")
		default:
			return fmt.Errorf("modules: update: %w", err)
		}
	}

	resp := make(map[string]any, len(updated)+1)
	for k, v := range updated {
		resp[k] = v
	}
	resp["requires_restart"] = true
	return c.JSON(http.StatusOK, resp)
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
