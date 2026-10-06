package event

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"core/internal/auth"
	"core/orm"
	"core/orm/access"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Calendar feeds (RFC 5545): a published event's sessions (public), one
// booking for its visitor, and a private staff feed of every session and
// appointment, subscribed to by a secret per-user link.

// EventFeed is a staff member's calendar feed token; only its sha256 is
// stored. One live row per user: regenerating replaces it, so an old link
// stops working. Off the generic CRUD surface.
type EventFeed struct {
	model.BaseModel
	UserID    uuid.UUID `db:"user_id,index"`
	TokenHash string    `db:"token_hash"`
}

func writeCalendar(c *echo.Context, cal Calendar, filename string) error {
	c.Response().Header().Set("Content-Disposition", `inline; filename="`+filename+`"`)
	return c.Blob(http.StatusOK, "text/calendar; charset=utf-8", cal.Bytes())
}

// PublicCalendar handles GET /api/v1/public/event/:id/calendar.ics — the
// future sessions of a published event (an appointment event has none).
func (h *Handler) PublicCalendar(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	ev, err := orm.MustRepo[Event](h.db).FindOne(ctx, orm.Cond("id = $1 AND tenant_id = $2 AND published IS TRUE", id, tenant))
	if isNoRows(err) {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	if err != nil {
		return err
	}
	sessions, err := orm.Select[EventSession](orm.MustRepo[EventSession](h.db).Meta()).
		Where(orm.Cond("event_id = $1 AND starts_at > now() AND deleted_at IS NULL", ev.ID)).
		OrderBy("starts_at").Limit(500).All(ctx, h.db)
	if err != nil {
		return err
	}
	cal := Calendar{Name: ev.Name}
	for _, s := range sessions {
		e := CalendarEvent{UID: "session-" + s.ID.String(), Start: s.StartsAt, End: s.EndsAt, Summary: ev.Name}
		if ev.Location != nil {
			e.Location = *ev.Location
		}
		cal.Events = append(cal.Events, e)
	}
	return writeCalendar(c, cal, "event.ics")
}

// MyBookingCalendar handles GET /api/v1/website/me/bookings/:id/calendar.ics
// (website token): the visitor's own booking, 404 for anyone else's.
func (h *Handler) MyBookingCalendar(c *echo.Context) error {
	ctx := c.Request().Context()
	id, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	bid, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	var b EventBooking
	ev := Event{TenantID: id.TenantID}
	err = h.db.QueryRow(ctx, `SELECT b.id, b.seats, b.session_id, b.slot_end, b.starts_at, b.status, e.name, e.location
		FROM event_booking b JOIN event e ON e.id = b.event_id
		WHERE b.id = $1 AND b.tenant_id = $2 AND b.user_id = $3 AND b.deleted_at IS NULL`, bid, id.TenantID, id.UserID).
		Scan(&b.ID, &b.Seats, &b.SessionID, &b.SlotEnd, &b.StartsAt, &b.Status, &ev.Name, &ev.Location)
	if isNoRows(err) || (err == nil && b.StartsAt == nil) {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	if err != nil {
		return err
	}
	invite, err := bookingInvite(ctx, h.db, ev, b, *b.StartsAt, b.Status == BookingCancelled)
	if err != nil {
		return err
	}
	return c.Blob(http.StatusOK, "text/calendar; charset=utf-8", invite.Data)
}

// RoleResolver and PermissionChecker are what the staff feed needs from auth
// (defined here, at the call site).
type RoleResolver interface {
	FindRoleNames(ctx context.Context, userID uuid.UUID) ([]string, error)
}
type PermissionChecker interface {
	Has(ctx context.Context, roles []string, required string) (bool, error)
}

// FeedHandler serves the staff calendar feed.
type FeedHandler struct {
	db    *orm.DB
	roles RoleResolver
	perms PermissionChecker
}

func NewFeedHandler(db *orm.DB, roles RoleResolver, perms PermissionChecker) *FeedHandler {
	return &FeedHandler{db: db, roles: roles, perms: perms}
}

// feedPermission is what a feed's owner must still hold at every fetch.
const feedPermission = "event_session:event_session:read"

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// GetMine handles GET /api/v1/me/event_feed: whether the caller has a feed.
func (h *FeedHandler) GetMine(c *echo.Context) error {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	var n int
	if err := h.db.QueryRow(ctx, `SELECT count(*) FROM event_feed WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		id.TenantID, id.UserID).Scan(&n); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"enabled": n > 0})
}

// Create handles POST /api/v1/me/event_feed: a new secret link replacing the
// caller's previous one. The raw token is returned once, never stored.
func (h *FeedHandler) Create(c *echo.Context) error {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	if ok, err := h.allowed(ctx, id.UserID); err != nil || !ok {
		if err != nil {
			return err
		}
		return echo.NewHTTPError(http.StatusForbidden, "the calendar feed needs "+feedPermission)
	}
	raw, err := randomToken()
	if err != nil {
		return err
	}
	err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM event_feed WHERE tenant_id = $1 AND user_id = $2`, id.TenantID, id.UserID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO event_feed (tenant_id, user_id, token_hash) VALUES ($1, $2, $3)`,
			id.TenantID, id.UserID, hashToken(raw))
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, map[string]any{"path": "/api/v1/calendar/" + raw + ".ics"})
}

// Delete handles DELETE /api/v1/me/event_feed: the link stops working.
func (h *FeedHandler) Delete(c *echo.Context) error {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	if _, err := h.db.Exec(ctx, `DELETE FROM event_feed WHERE tenant_id = $1 AND user_id = $2`, id.TenantID, id.UserID); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *FeedHandler) allowed(ctx context.Context, userID uuid.UUID) (bool, error) {
	roles, err := h.roles.FindRoleNames(ctx, userID)
	if err != nil {
		return false, err
	}
	return h.perms.Has(ctx, roles, feedPermission)
}

// Feed handles GET /api/v1/calendar/:file (file = <token>.ics, no session —
// calendar apps can't log in): every session from 30 days ago to 180 days
// ahead with its fill, plus confirmed appointment bookings. 404 for an
// unknown token, or a user who lost the permission or was removed.
func (h *FeedHandler) Feed(c *echo.Context) error {
	ctx := c.Request().Context()
	raw := strings.TrimSuffix(c.Param("file"), ".ics")
	if len(raw) != 64 {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	var tenant, userID uuid.UUID
	err := h.db.QueryRow(ctx, `SELECT f.tenant_id, f.user_id FROM event_feed f JOIN users u ON u.id = f.user_id
		WHERE f.token_hash = $1 AND f.deleted_at IS NULL AND u.deleted_at IS NULL`, hashToken(raw)).Scan(&tenant, &userID)
	if isNoRows(err) {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	if err != nil {
		return err
	}
	if ok, err := h.allowed(ctx, userID); err != nil || !ok {
		if err != nil {
			return err
		}
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	from, to := time.Now().AddDate(0, 0, -30), time.Now().AddDate(0, 0, 180)
	cal := Calendar{Name: "Events"}
	rows, err := h.db.Query(ctx, `SELECT s.id, s.starts_at, s.ends_at, s.capacity, s.seats_taken, e.name, e.location
		FROM event_session s JOIN event e ON e.id = s.event_id
		WHERE s.tenant_id = $1 AND s.deleted_at IS NULL AND e.deleted_at IS NULL AND s.starts_at BETWEEN $2 AND $3
		ORDER BY s.starts_at LIMIT 2000`, tenant, from, to)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id uuid.UUID
		var start, end time.Time
		var capacity, taken int
		var name string
		var loc *string
		if err := rows.Scan(&id, &start, &end, &capacity, &taken, &name, &loc); err != nil {
			rows.Close()
			return err
		}
		e := CalendarEvent{UID: "session-" + id.String(), Start: start, End: end, Summary: fmt.Sprintf("%s (%d/%d)", name, taken, capacity)}
		if loc != nil {
			e.Location = *loc
		}
		cal.Events = append(cal.Events, e)
	}
	rows.Close()
	rows, err = h.db.Query(ctx, `SELECT b.id, b.slot_start, b.slot_end, b.name, b.seats, e.name, e.location
		FROM event_booking b JOIN event e ON e.id = b.event_id
		WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND b.slot_start BETWEEN $2 AND $3
		  AND b.status IN ($4, $5, $6) ORDER BY b.slot_start LIMIT 2000`, tenant, from, to, BookingConfirmed, BookingAttended, BookingNoShow)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var start, end time.Time
		var who, name string
		var seats int
		var loc *string
		if err := rows.Scan(&id, &start, &end, &who, &seats, &name, &loc); err != nil {
			return err
		}
		e := CalendarEvent{UID: "booking-" + id.String(), Start: start, End: end, Summary: fmt.Sprintf("%s — %s (%d)", name, who, seats)}
		if loc != nil {
			e.Location = *loc
		}
		cal.Events = append(cal.Events, e)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return writeCalendar(c, cal, "events.ics")
}
