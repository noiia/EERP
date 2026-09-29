package event

import (
	"net/http"
	"time"

	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Handler serves the event module's dedicated routes.
type Handler struct {
	db *orm.DB
}

// NewHandler builds the handler.
func NewHandler(db *orm.DB) *Handler { return &Handler{db: db} }

// PublicSessions handles GET /api/v1/public/event/:id/sessions — future
// sessions of a PUBLISHED event (a session's visibility is its event's, which
// the generic public scope can't express, hence a dedicated route).
func (h *Handler) PublicSessions(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	rows, err := h.db.Query(ctx, `
		SELECT s.id, s.starts_at, s.ends_at, s.capacity, s.seats_taken, s.price
		FROM event_session s JOIN event e ON e.id = s.event_id
		WHERE e.id = $1 AND e.tenant_id = $2 AND s.tenant_id = $2 AND e.published
		  AND e.deleted_at IS NULL AND s.deleted_at IS NULL AND s.starts_at > now()
		ORDER BY s.starts_at LIMIT 200`, id, tenant)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var sid uuid.UUID
		var start, end time.Time
		var capacity, taken int
		var price *float64
		if err := rows.Scan(&sid, &start, &end, &capacity, &taken, &price); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": sid, "starts_at": start, "ends_at": end,
			"capacity": capacity, "seats_left": capacity - taken, "price": price})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"data": out})
}
