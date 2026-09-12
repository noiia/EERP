package notebook

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// Handler serves the dedicated notebook-pages endpoints. Mounted behind
// jwtMw + permMw: the permission middleware derives
// notebook_pages:notebook_pages:read|write|delete from the route, and every
// query is pinned to the caller's tenant. This is the only HTTP path to the
// notebook_page table — it stays off the generic CRUD surface, the same
// posture internal/pictures and the auth admin endpoints take.

// anchorNamePattern keeps the table name shaped like an identifier — it never
// becomes a SQL identifier itself (always bound as a parameter), but junk
// stays out of the row.
var anchorNamePattern = regexp.MustCompile(`^[a-z0-9_]{1,63}$`)

const maxTitleLen = 200

// notebookStore is the call-site interface the handler needs from the repository.
type notebookStore interface {
	Create(ctx context.Context, p NotebookPage) (NotebookPage, error)
	Update(ctx context.Context, p NotebookPage, id uuid.UUID) (NotebookPage, error)
	FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (NotebookPage, error)
	ListByAnchor(ctx context.Context, tenantID uuid.UUID, table string, recordID uuid.UUID) ([]NotebookPage, error)
	Delete(ctx context.Context, tenantID, id uuid.UUID) error
}

type Handler struct {
	store notebookStore
}

// NewHandler constructs the notebook Handler from the concrete repository.
func NewHandler(store *Repository) *Handler {
	return &Handler{store: store}
}

// newHandlerWith constructs a Handler from an interface value (tests).
func newHandlerWith(store notebookStore) *Handler {
	return &Handler{store: store}
}

type pageResponse struct {
	ID        uuid.UUID `json:"id"`
	TableName string    `json:"table_name"`
	RecordID  uuid.UUID `json:"record_id"`
	Title     string    `json:"title"`
	Position  int       `json:"position"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func toResponse(p NotebookPage) pageResponse {
	return pageResponse{
		ID: p.ID, TableName: p.TableName, RecordID: p.RecordID,
		Title: p.Title, Position: p.Position, Content: p.Content,
		CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
	}
}

// listEnvelope mirrors the generic CRUD list shape ({data, total}) so the
// frontend's Server Action can parse it exactly like every other dedicated
// list endpoint (internal/auth's admin handlers do the same).
type listEnvelope struct {
	Data  []pageResponse `json:"data"`
	Total int            `json:"total"`
}

// List handles GET /api/v1/notebook_pages?table=&record= — every page on the
// anchor, ordered by Position (creation order in v1).
func (h *Handler) List(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	table := c.QueryParam("table")
	if !anchorNamePattern.MatchString(table) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "table must be a lowercase identifier.")
	}
	recordID, err := uuid.Parse(c.QueryParam("record"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "record must be a UUID.")
	}

	pages, err := h.store.ListByAnchor(c.Request().Context(), identity.TenantID, table, recordID)
	if err != nil {
		return fmt.Errorf("notebook: list: %w", err)
	}
	data := make([]pageResponse, 0, len(pages))
	for _, p := range pages {
		data = append(data, toResponse(p))
	}
	return c.JSON(http.StatusOK, listEnvelope{Data: data, Total: len(data)})
}

// Create handles POST /api/v1/notebook_pages — body carries the anchor
// (table_name, record_id) plus title (content optional, starts empty).
// Position is server-assigned: the current page count for the anchor, so
// pages always append in creation order.
func (h *Handler) Create(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var req struct {
		TableName string `json:"table_name"`
		RecordID  string `json:"record_id"`
		Title     string `json:"title"`
		Content   string `json:"content"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if !anchorNamePattern.MatchString(req.TableName) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "table_name must be a lowercase identifier.")
	}
	recordID, err := uuid.Parse(req.RecordID)
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "record_id must be a UUID.")
	}
	title := strings.TrimSpace(req.Title)
	if msg := validateTitle(title); msg != "" {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", msg)
	}

	existing, err := h.store.ListByAnchor(c.Request().Context(), identity.TenantID, req.TableName, recordID)
	if err != nil {
		return fmt.Errorf("notebook: create: list anchor: %w", err)
	}

	created, err := h.store.Create(c.Request().Context(), NotebookPage{
		TenantID: identity.TenantID, TableName: req.TableName, RecordID: recordID,
		Title: title, Position: len(existing), Content: req.Content,
	})
	if err != nil {
		return fmt.Errorf("notebook: create: %w", err)
	}
	return c.JSON(http.StatusCreated, toResponse(created))
}

// Update handles PUT /api/v1/notebook_pages/:id — title and content are the
// only writable fields; the anchor and position never change after creation.
func (h *Handler) Update(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id must be a UUID.")
	}
	var req struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	title := strings.TrimSpace(req.Title)
	if msg := validateTitle(title); msg != "" {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", msg)
	}

	existing, err := h.store.FindInTenant(c.Request().Context(), identity.TenantID, id)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such page.")
		}
		return fmt.Errorf("notebook: update: find: %w", err)
	}
	existing.Title = title
	existing.Content = req.Content

	updated, err := h.store.Update(c.Request().Context(), existing, id)
	if err != nil {
		return fmt.Errorf("notebook: update: %w", err)
	}
	return c.JSON(http.StatusOK, toResponse(updated))
}

// Delete handles DELETE /api/v1/notebook_pages/:id.
func (h *Handler) Delete(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id must be a UUID.")
	}
	if err := h.store.Delete(c.Request().Context(), identity.TenantID, id); err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such page.")
		}
		return fmt.Errorf("notebook: delete: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}

func validateTitle(title string) string {
	if title == "" {
		return "title is required."
	}
	if len(title) > maxTitleLen {
		return fmt.Sprintf("title too long (max %d characters).", maxTitleLen)
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
