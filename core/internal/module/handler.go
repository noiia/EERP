package module

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
)

// Handler serves the dedicated module-management endpoints backing the App
// Store (docs/roadmaps/app-store.md, Phase 1 + the live-lifecycle work):
// GET (list, generic envelope), GET /:id, PUT /:id (activate/deactivate),
// POST /:id/reload, GET /:id/logs. Never tenant-scoped — modules are
// workspace-wide, not per-tenant data — so, unlike pictures/notebook, there
// is no auth.MustIdentity here. Mounted behind jwtMw + permMw; the
// permission middleware derives modules:modules:read|write from the route.

// moduleStore is the call-site interface the handler needs for read-only
// module.json access (List/Get) — satisfied by *Manager.
type moduleStore interface {
	List(ctx context.Context) ([]map[string]any, error)
	Get(ctx context.Context, id string) (map[string]any, error)
}

// moduleRuntime is the call-site interface the handler needs for live
// lifecycle operations — satisfied by *Registry.
type moduleRuntime interface {
	SetActive(ctx context.Context, id string, active bool) (map[string]any, error)
	Reload(ctx context.Context, id string) (map[string]any, error)
	Logs(ctx context.Context, id string) ([]ModuleOperationLog, error)
}

type Handler struct {
	store   moduleStore
	runtime moduleRuntime
}

// NewHandler constructs the modules Handler from the concrete Manager and
// Registry. Manager still owns raw module.json read access; Registry owns
// runtime state (active gate, WASM lifecycle, operation logs) — kept
// separate on purpose, mirroring the existing "typed detector vs raw
// manager" split documented in manager.go.
func NewHandler(store *Manager, runtime *Registry) *Handler {
	return &Handler{store: store, runtime: runtime}
}

// newHandlerWith constructs a Handler from interface values (tests).
func newHandlerWith(store moduleStore, runtime moduleRuntime) *Handler {
	return &Handler{store: store, runtime: runtime}
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
// is "active" (boolean). Unlike the old file-write-only design, this now
// flips the runtime active-gate immediately (Registry.SetActive) — the
// change is live before the handler even returns, no
// requires_restart/rebuild needed, and module.json is written last, once the
// runtime change has already succeeded.
func (h *Handler) Update(c echo.Context) error {
	var changes map[string]any
	if err := json.NewDecoder(c.Request().Body).Decode(&changes); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}

	active, verr := validateActiveChange(changes)
	if verr != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", verr.Message)
	}

	updated, err := h.runtime.SetActive(c.Request().Context(), c.Param("id"), active)
	if err != nil {
		var ve *ValidationError
		switch {
		case errors.As(err, &ve):
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", ve.Message)
		case errors.Is(err, ErrModuleNotFound):
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such module.")
		default:
			return fmt.Errorf("modules: update: %w", err)
		}
	}
	return c.JSON(http.StatusOK, updated)
}

// Reload handles POST /api/v1/modules/:id/reload — the "upgradable directly
// on run" affordance: re-instantiates a WASM module's (possibly replaced)
// binary and re-runs its migration with no restart, or re-validates a
// Go-type module's schema registration (its code needs a backend
// rebuild+restart to actually change — see Registry.Reload).
func (h *Handler) Reload(c echo.Context) error {
	updated, err := h.runtime.Reload(c.Request().Context(), c.Param("id"))
	if err != nil {
		if errors.Is(err, ErrModuleNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such module.")
		}
		return fmt.Errorf("modules: reload: %w", err)
	}
	return c.JSON(http.StatusOK, updated)
}

type logEntryResponse struct {
	OperationID string    `json:"operation_id"`
	Operation   string    `json:"operation"`
	Source      string    `json:"source"`
	Level       string    `json:"level"`
	Message     string    `json:"message"`
	CreatedAt   time.Time `json:"created_at"`
}

type logsEnvelope struct {
	Data  []logEntryResponse `json:"data"`
	Total int                `json:"total"`
}

// Logs handles GET /api/v1/modules/:id/logs — every recorded
// activate/deactivate/reload log line for the module, most recent operation
// first. Backs the App Store's Logs wizard.
func (h *Handler) Logs(c echo.Context) error {
	entries, err := h.runtime.Logs(c.Request().Context(), c.Param("id"))
	if err != nil {
		return fmt.Errorf("modules: logs: %w", err)
	}
	data := make([]logEntryResponse, 0, len(entries))
	for _, e := range entries {
		data = append(data, logEntryResponse{
			OperationID: e.OperationID.String(),
			Operation:   e.Operation,
			Source:      e.Source,
			Level:       e.Level,
			Message:     e.Message,
			CreatedAt:   e.CreatedAt,
		})
	}
	return c.JSON(http.StatusOK, logsEnvelope{Data: data, Total: len(data)})
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
