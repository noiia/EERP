package mail

import (
	"net/http"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Handler is the admin view of the outbox (mail_outbox:mail_outbox:read|write,
// route-derived). Tenant-pinned; bodies are not listed — only what an admin
// needs to spot and re-queue a failure.
type Handler struct{ db *orm.DB }

func NewHandler(db *orm.DB) *Handler { return &Handler{db: db} }

type outboxRow struct {
	ID            uuid.UUID  `json:"id"`
	ToAddress     string     `json:"to_address"`
	Subject       string     `json:"subject"`
	Status        string     `json:"status"`
	Attempts      int        `json:"attempts"`
	NextAttemptAt time.Time  `json:"next_attempt_at"`
	LastError     string     `json:"last_error"`
	SentAt        *time.Time `json:"sent_at"`
	CreatedAt     time.Time  `json:"created_at"`
}

// List handles GET /api/v1/mail_outbox?status=&page=&page_size=.
func (h *Handler) List(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	status := c.QueryParam("status")
	if status != "" && status != StatusPending && status != StatusSent && status != StatusFailed {
		return echo.NewHTTPError(http.StatusBadRequest, "status must be pending, sent or failed")
	}
	page, _ := echo.QueryParamOr(c, "page", 1)
	size, _ := echo.QueryParamOr(c, "page_size", 50)
	page = min(max(page, 1), 100000)
	if size < 1 || size > 200 {
		size = 50
	}
	const where = `WHERE tenant_id = $1 AND deleted_at IS NULL AND ($2 = '' OR status = $2)`
	var total int
	if err := h.db.QueryRow(ctx, `SELECT count(*) FROM mail_outbox `+where, tenant, status).Scan(&total); err != nil {
		return err
	}
	rows, err := h.db.Query(ctx, `
		SELECT id, to_address, subject, status, attempts, next_attempt_at, last_error, sent_at, created_at
		FROM mail_outbox `+where+` ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
		tenant, status, size, (page-1)*size)
	if err != nil {
		return err
	}
	defer rows.Close()
	data := []outboxRow{}
	for rows.Next() {
		var r outboxRow
		if err := rows.Scan(&r.ID, &r.ToAddress, &r.Subject, &r.Status, &r.Attempts, &r.NextAttemptAt, &r.LastError, &r.SentAt, &r.CreatedAt); err != nil {
			return err
		}
		data = append(data, r)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"data": data, "total": total})
}

// Retry handles POST /api/v1/mail_outbox/:id/retry — a failed row goes back
// to pending with a fresh attempt budget; anything else is a 404.
func (h *Handler) Retry(c *echo.Context) error {
	ctx := c.Request().Context()
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}
	tag, err := h.db.Exec(ctx, `
		UPDATE mail_outbox SET status = $3, attempts = 0, next_attempt_at = now(), updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND status = $4 AND deleted_at IS NULL`,
		id, auth.MustIdentity(ctx).TenantID, StatusPending, StatusFailed)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	return c.NoContent(http.StatusNoContent)
}
