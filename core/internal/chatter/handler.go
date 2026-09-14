package chatter

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// Handler serves the dedicated chatter-messages endpoints. Mounted behind
// jwtMw + permMw: the permission middleware derives
// chatter_messages:chatter_messages:read|write from the route, and every
// query is pinned to the caller's tenant. This is the only HTTP path to the
// chatter_message table — it stays off the generic CRUD surface, the same
// posture internal/notebook and internal/pictures take.

// anchorNamePattern keeps the table name shaped like an identifier — it never
// becomes a SQL identifier itself (always bound as a parameter), but junk
// stays out of the row.
var anchorNamePattern = regexp.MustCompile(`^[a-z0-9_]{1,63}$`)

const maxBodyLen = 4000

var validKinds = map[string]bool{"message": true, "log": true}

// userStore is the call-site interface the handler needs to snapshot an
// author's email at write time (mirrors internal/settings' userPreferenceStore).
type userStore interface {
	FindByID(ctx context.Context, id uuid.UUID) (auth.Users, error)
}

// chatterStore is the call-site interface the handler needs from the repository.
type chatterStore interface {
	Create(ctx context.Context, m ChatterMessage) (ChatterMessage, error)
	ListByAnchor(ctx context.Context, tenantID uuid.UUID, table string, recordID uuid.UUID) ([]ChatterMessage, error)
}

type Handler struct {
	store chatterStore
	users userStore
}

// NewHandler constructs the chatter Handler from concrete implementations.
func NewHandler(store *Repository, users *auth.UserRepository) *Handler {
	return &Handler{store: store, users: users}
}

// newHandlerWith constructs a Handler from interface values (tests).
func newHandlerWith(store chatterStore, users userStore) *Handler {
	return &Handler{store: store, users: users}
}

type messageResponse struct {
	ID          uuid.UUID `json:"id"`
	TableName   string    `json:"table_name"`
	RecordID    uuid.UUID `json:"record_id"`
	AuthorID    uuid.UUID `json:"author_id"`
	AuthorEmail string    `json:"author_email"`
	Kind        string    `json:"kind"`
	Body        string    `json:"body"`
	CreatedAt   time.Time `json:"created_at"`
}

func toResponse(m ChatterMessage) messageResponse {
	return messageResponse{
		ID: m.ID, TableName: m.TableName, RecordID: m.RecordID,
		AuthorID: m.AuthorID, AuthorEmail: m.AuthorEmail,
		Kind: m.Kind, Body: m.Body, CreatedAt: m.CreatedAt,
	}
}

// listEnvelope mirrors the generic CRUD list shape ({data, total}) so the
// frontend's Server Action can parse it exactly like every other dedicated
// list endpoint.
type listEnvelope struct {
	Data  []messageResponse `json:"data"`
	Total int               `json:"total"`
}

// List handles GET /api/v1/chatter_messages?table=&record= — every entry on
// the anchor, newest first.
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

	messages, err := h.store.ListByAnchor(c.Request().Context(), identity.TenantID, table, recordID)
	if err != nil {
		return fmt.Errorf("chatter: list: %w", err)
	}
	data := make([]messageResponse, 0, len(messages))
	for _, m := range messages {
		data = append(data, toResponse(m))
	}
	return c.JSON(http.StatusOK, listEnvelope{Data: data, Total: len(data)})
}

// Create handles POST /api/v1/chatter_messages — body carries the anchor
// (table_name, record_id), kind ("message" from the composer, "log" from the
// form's own post-save summary — both posted the same way, see module doc),
// and body text. Author is always the authenticated caller, never trusted
// from the request.
func (h *Handler) Create(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var req struct {
		TableName string `json:"table_name"`
		RecordID  string `json:"record_id"`
		Kind      string `json:"kind"`
		Body      string `json:"body"`
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
	if !validKinds[req.Kind] {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", `kind must be "message" or "log".`)
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "body is required.")
	}
	if len(body) > maxBodyLen {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", fmt.Sprintf("body exceeds %d characters.", maxBodyLen))
	}

	author, err := h.users.FindByID(c.Request().Context(), identity.UserID)
	if err != nil {
		return fmt.Errorf("chatter: create: find author: %w", err)
	}

	created, err := h.store.Create(c.Request().Context(), ChatterMessage{
		TenantID: identity.TenantID, TableName: req.TableName, RecordID: recordID,
		AuthorID: identity.UserID, AuthorEmail: author.Email,
		Kind: req.Kind, Body: body,
	})
	if err != nil {
		return fmt.Errorf("chatter: create: %w", err)
	}
	return c.JSON(http.StatusCreated, toResponse(created))
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
