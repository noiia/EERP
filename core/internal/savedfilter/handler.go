package savedfilter

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// Handler serves the dedicated saved-filter endpoints. Mounted behind
// jwtMw + permMw: the permission middleware derives
// saved_filters:saved_filters:read|write|delete from the route, and every
// query is pinned to the caller's tenant. This is the only HTTP path to the
// saved_filter table — it stays off the generic CRUD surface, the same
// posture internal/notebook and internal/pictures take.

// entityNamePattern keeps the entity column shaped like a route prefix — it
// never becomes a SQL identifier itself (always bound as a parameter), but
// junk stays out of the row.
var entityNamePattern = regexp.MustCompile(`^[a-z0-9_]{1,63}$`)

const maxNameLen = 200

// savedFilterStore is the call-site interface the handler needs from the repository.
type savedFilterStore interface {
	Create(ctx context.Context, sf SavedFilter) (SavedFilter, error)
	Update(ctx context.Context, sf SavedFilter, id uuid.UUID) (SavedFilter, error)
	FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (SavedFilter, error)
	ListVisible(ctx context.Context, tenantID, userID uuid.UUID, entity string) ([]SavedFilter, error)
	Delete(ctx context.Context, tenantID, id uuid.UUID) error
}

type Handler struct {
	store savedFilterStore
}

// NewHandler constructs the saved-filter Handler from the concrete repository.
func NewHandler(store *Repository) *Handler {
	return &Handler{store: store}
}

// newHandlerWith constructs a Handler from an interface value (tests).
func newHandlerWith(store savedFilterStore) *Handler {
	return &Handler{store: store}
}

type filterResponse struct {
	ID     uuid.UUID `json:"id"`
	Entity string    `json:"entity"`
	Name   string    `json:"name"`
	Shared bool      `json:"shared"`
	Config string    `json:"config"`
	// Mine reports whether the caller owns this row — the frontend uses it
	// to decide whether to show rename/delete affordances on a shared
	// filter someone else created; the backend still enforces the real
	// owner-only check independently on Update/Delete.
	Mine bool `json:"mine"`
}

func toResponse(sf SavedFilter, callerID uuid.UUID) filterResponse {
	return filterResponse{
		ID: sf.ID, Entity: sf.Entity, Name: sf.Name, Shared: sf.Shared,
		Config: sf.Config, Mine: sf.UserID == callerID,
	}
}

// listEnvelope mirrors the generic CRUD list shape ({data, total}) so the
// frontend's Server Action can parse it exactly like every other dedicated
// list endpoint (internal/notebook does the same).
type listEnvelope struct {
	Data  []filterResponse `json:"data"`
	Total int              `json:"total"`
}

// List handles GET /api/v1/saved_filters?entity= — every filter the caller
// may use on that entity's search bar: their own (private or shared) plus
// every other user's shared filter.
func (h *Handler) List(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	entity := c.QueryParam("entity")
	if !entityNamePattern.MatchString(entity) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "entity must be a lowercase identifier.")
	}

	filters, err := h.store.ListVisible(c.Request().Context(), identity.TenantID, identity.UserID, entity)
	if err != nil {
		return fmt.Errorf("saved_filter: list: %w", err)
	}
	data := make([]filterResponse, 0, len(filters))
	for _, sf := range filters {
		data = append(data, toResponse(sf, identity.UserID))
	}
	return c.JSON(http.StatusOK, listEnvelope{Data: data, Total: len(data)})
}

// Create handles POST /api/v1/saved_filters — body carries entity, name,
// shared, and the opaque config blob. The row's owner is always the caller,
// even when Shared is true.
func (h *Handler) Create(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var req struct {
		Entity string `json:"entity"`
		Name   string `json:"name"`
		Shared bool   `json:"shared"`
		Config string `json:"config"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if !entityNamePattern.MatchString(req.Entity) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "entity must be a lowercase identifier.")
	}
	if msg := validateName(req.Name); msg != "" {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", msg)
	}

	created, err := h.store.Create(c.Request().Context(), SavedFilter{
		TenantID: identity.TenantID, UserID: identity.UserID,
		Entity: req.Entity, Name: req.Name, Shared: req.Shared, Config: req.Config,
	})
	if err != nil {
		if errors.Is(err, ErrDuplicateSavedFilterName) {
			return errorJSON(c, http.StatusConflict, "CONFLICT", ErrDuplicateSavedFilterName.Error())
		}
		return fmt.Errorf("saved_filter: create: %w", err)
	}
	return c.JSON(http.StatusCreated, toResponse(created, identity.UserID))
}

// Update handles PUT /api/v1/saved_filters/:id — rename/reconfigure/reshare.
// Owner-only, even for a shared filter: no admin-override affordance in v1.
func (h *Handler) Update(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id must be a UUID.")
	}
	var req struct {
		Name   string `json:"name"`
		Shared bool   `json:"shared"`
		Config string `json:"config"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if msg := validateName(req.Name); msg != "" {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", msg)
	}

	existing, err := h.store.FindInTenant(c.Request().Context(), identity.TenantID, id)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such saved filter.")
		}
		return fmt.Errorf("saved_filter: update: find: %w", err)
	}
	if existing.UserID != identity.UserID {
		return errorJSON(c, http.StatusForbidden, "FORBIDDEN", "Only the owner can change this saved filter.")
	}
	existing.Name = req.Name
	existing.Shared = req.Shared
	existing.Config = req.Config

	updated, err := h.store.Update(c.Request().Context(), existing, id)
	if err != nil {
		if errors.Is(err, ErrDuplicateSavedFilterName) {
			return errorJSON(c, http.StatusConflict, "CONFLICT", ErrDuplicateSavedFilterName.Error())
		}
		return fmt.Errorf("saved_filter: update: %w", err)
	}
	return c.JSON(http.StatusOK, toResponse(updated, identity.UserID))
}

// Delete handles DELETE /api/v1/saved_filters/:id. Owner-only, even for a
// shared filter.
func (h *Handler) Delete(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id must be a UUID.")
	}

	existing, err := h.store.FindInTenant(c.Request().Context(), identity.TenantID, id)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such saved filter.")
		}
		return fmt.Errorf("saved_filter: delete: find: %w", err)
	}
	if existing.UserID != identity.UserID {
		return errorJSON(c, http.StatusForbidden, "FORBIDDEN", "Only the owner can delete this saved filter.")
	}

	if err := h.store.Delete(c.Request().Context(), identity.TenantID, id); err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such saved filter.")
		}
		return fmt.Errorf("saved_filter: delete: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}

func validateName(name string) string {
	if name == "" {
		return "name is required."
	}
	if len(name) > maxNameLen {
		return fmt.Sprintf("name too long (max %d characters).", maxNameLen)
	}
	return ""
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
