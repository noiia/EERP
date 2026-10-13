package notify

import (
	"encoding/json"
	"net/http"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Handler serves the caller's own feed. Both routes act only on the identity
// in the token — no route takes a user id — so they need the JWT middleware,
// not a permission: everyone reads their own notifications.
type Handler struct{ svc *Service }

// NewHandler wires the handler.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// List handles GET /api/v1/notifications.
func (h *Handler) List(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	items, unread, err := h.svc.repo.Feed(c.Request().Context(), id.TenantID, id.UserID)
	if err != nil {
		return err
	}
	out := make([]WireItem, 0, len(items))
	for _, it := range items {
		out = append(out, WireItem{Wire: toWire(it.Notification), Read: it.Read})
	}
	return c.JSON(http.StatusOK, map[string]any{"data": out, "unread": unread})
}

type markReadRequest struct {
	IDs []uuid.UUID `json:"ids"`
	All bool        `json:"all"`
}

// MarkRead handles POST /api/v1/notifications/read. Ids the caller can't see
// are ignored; the caller's other tabs get a notification_read frame.
func (h *Handler) MarkRead(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	var req markReadRequest
	if err := json.NewDecoder(c.Request().Body).Decode(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": map[string]string{
			"code": "VALIDATION_ERROR", "message": "Malformed request body."}})
	}
	marked, err := h.svc.repo.MarkRead(c.Request().Context(), id.TenantID, id.UserID, req.IDs, req.All)
	if err != nil {
		return err
	}
	if marked == nil {
		marked = []uuid.UUID{}
	}
	if h.svc.pub != nil && (req.All || len(marked) > 0) {
		frame := map[string]any{"type": "notification_read", "ids": marked}
		if req.All {
			frame = map[string]any{"type": "notification_read", "all": true}
		}
		if payload, err := json.Marshal(frame); err == nil {
			h.svc.pub.SendToUsers(id.TenantID, []uuid.UUID{id.UserID}, payload)
		}
	}
	return c.JSON(http.StatusOK, map[string]any{"ids": marked})
}
