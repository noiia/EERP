package event

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"time"

	"core/internal/auth"
	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Handler serves the event module's dedicated routes.
type Handler struct {
	db  *orm.DB
	svc *Service
}

// NewHandler builds the handler.
func NewHandler(db *orm.DB, svc *Service) *Handler { return &Handler{db: db, svc: svc} }

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

// httpErr maps the booking service's errors. Not-bookable and not-found share
// one 404 so a caller can't probe which events or tokens exist.
func httpErr(err error) error {
	switch {
	case errors.Is(err, ErrFull):
		return echo.NewHTTPError(http.StatusConflict, "no seats left")
	case errors.Is(err, ErrNotBookable), errors.Is(err, ErrNotFound):
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	case errors.Is(err, ErrBadRequest):
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	return err
}

// PublicSlots handles GET /api/v1/public/event/:id/slots?from=&to= (RFC 3339;
// default: the next 7 days).
func (h *Handler) PublicSlots(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	from, to := time.Now(), time.Now().AddDate(0, 0, 7)
	for key, dst := range map[string]*time.Time{"from": &from, "to": &to} {
		if raw := c.QueryParam(key); raw != "" {
			if *dst, err = time.Parse(time.RFC3339, raw); err != nil {
				return echo.NewHTTPError(http.StatusBadRequest, key+" must be an RFC 3339 time")
			}
		}
	}
	slots, err := h.svc.Slots(ctx, tenant, id, from, to)
	if err != nil {
		return httpErr(err)
	}
	return c.JSON(http.StatusOK, map[string]any{"data": slots})
}

// bookBody is what a booking request may carry — deliberately NOT
// BookRequest: identity (UserID) and the staff bypass never come from a body.
type bookBody struct {
	EventID   uuid.UUID  `json:"event_id"`
	SessionID *uuid.UUID `json:"session_id"`
	SlotStart *time.Time `json:"slot_start"`
	Seats     int        `json:"seats"`
	Email     string     `json:"email"`
	Name      string     `json:"name"`
	Phone     string     `json:"phone"`
}

func (h *Handler) book(c *echo.Context, staff bool) (EventBooking, error) {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	var in bookBody
	if err := json.NewDecoder(c.Request().Body).Decode(&in); err != nil {
		return EventBooking{}, echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	req := BookRequest{EventID: in.EventID, SessionID: in.SessionID, SlotStart: in.SlotStart, Seats: in.Seats,
		Email: in.Email, Name: in.Name, Phone: in.Phone, Staff: staff}
	if id, ok := auth.IdentityFromContext(ctx); ok && !staff {
		req.UserID = &id.UserID
	}
	b, err := h.svc.Book(ctx, tenant, req)
	return b, httpErr(err)
}

// Book handles POST /api/v1/website/bookings — anonymous visitor or logged-in
// website user (then the booking is theirs). The response never says whether
// the email belongs to an account.
func (h *Handler) Book(c *echo.Context) error {
	b, err := h.book(c, false)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, map[string]any{"id": b.ID, "status": b.Status})
}

// StaffBook returns the POST /api/v1/event_booking override of the generic
// create: the same seat accounting as the site (staff may book unpublished
// events), answered by the generic get so the ERP form gets its usual record.
func (h *Handler) StaffBook(get echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		b, err := h.book(c, true)
		if err != nil {
			return err
		}
		c.SetPathValues(echo.PathValues{{Name: "id", Value: b.ID.String()}})
		return get(c)
	}
}

// CancelByToken handles POST /api/v1/website/bookings/cancel {token}.
func (h *Handler) CancelByToken(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	var in struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(c.Request().Body).Decode(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if err := h.svc.CancelByToken(ctx, tenant, in.Token); err != nil {
		return httpErr(err)
	}
	return c.JSON(http.StatusOK, map[string]any{"status": BookingCancelled})
}

// MyBookings handles GET /api/v1/website/me/bookings (website token).
func (h *Handler) MyBookings(c *echo.Context) error {
	ctx := c.Request().Context()
	id, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	rows, err := h.db.Query(ctx, `
		SELECT b.id, b.event_id, e.name, COALESCE(s.starts_at, b.slot_start), COALESCE(s.ends_at, b.slot_end), b.seats, b.status
		FROM event_booking b
		JOIN event e ON e.id = b.event_id
		LEFT JOIN event_session s ON s.id = b.session_id
		WHERE b.tenant_id = $1 AND b.user_id = $2 AND b.deleted_at IS NULL
		ORDER BY b.created_at DESC LIMIT 200`, id.TenantID, id.UserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var bid, eid uuid.UUID
		var name, status string
		var start, end *time.Time
		var seats int
		if err := rows.Scan(&bid, &eid, &name, &start, &end, &seats, &status); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": bid, "event_id": eid, "event_name": name,
			"start": start, "end": end, "seats": seats, "status": status})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"data": out})
}

// CancelMine handles POST /api/v1/website/me/bookings/:id/cancel — 404 unless
// the booking is the caller's.
func (h *Handler) CancelMine(c *echo.Context) error {
	ctx := c.Request().Context()
	id, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	bid, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	if err := h.svc.CancelByID(ctx, id.TenantID, bid, &id.UserID); err != nil {
		return httpErr(err)
	}
	return c.JSON(http.StatusOK, map[string]any{"status": BookingCancelled})
}

// StaffUpdate returns the PUT /api/v1/event_booking/:id override of the
// generic update. Only name/phone change freely; status "cancelled" cancels
// through the service (freeing the seats). Any other key must carry its
// stored value — the ERP form PUTs its whole draft — or it's a 400: seats,
// target or event changes would make seat counts drift (cancel and rebook).
// Answered by the generic get.
func (h *Handler) StaffUpdate(get echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		tenant, _ := access.TenantFromContext(ctx)
		id, err := echo.PathParam[uuid.UUID](c, "id")
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
		}
		var body map[string]any
		if err := json.NewDecoder(c.Request().Body).Decode(&body); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
		}
		var raw []byte
		err = h.db.QueryRow(ctx, `SELECT to_jsonb(b) - 'cancel_token' FROM event_booking b
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant).Scan(&raw)
		if isNoRows(err) {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		if err != nil {
			return err
		}
		var stored map[string]any
		if err := json.Unmarshal(raw, &stored); err != nil {
			return err
		}
		set := map[string]any{}
		cancel := false
		for k, v := range body {
			s, isStr := v.(string)
			switch {
			case k == "name" && isStr && strings.TrimSpace(s) != "" && len(s) <= 200:
				set[k] = strings.TrimSpace(s)
			case k == "phone" && (v == nil || (isStr && len(s) <= 50)):
				set[k] = v
			case k == "status" && v == BookingCancelled && stored[k] != BookingCancelled:
				cancel = true
			case sameValue(v, stored[k]):
			default:
				return echo.NewHTTPError(http.StatusBadRequest,
					"only name, phone, or status \"cancelled\" can be changed; cancel and rebook for anything else ("+k+")")
			}
		}
		if len(set) > 0 {
			q := orm.MustRepo[EventBooking](h.db).UpdateQuery().Where(orm.Cond("id = $1 AND tenant_id = $2", id, tenant))
			for k, v := range set {
				q = q.Set(k, v)
			}
			if _, err := q.Set("updated_at", time.Now()).Exec(ctx, h.db); err != nil {
				return err
			}
		}
		if cancel {
			if err := h.svc.CancelByID(ctx, tenant, id, nil); err != nil {
				return httpErr(err)
			}
		}
		return get(c)
	}
}

// sameValue compares a request value with its stored JSON counterpart;
// timestamps compare as instants (Go and Postgres format them differently).
func sameValue(a, b any) bool {
	if reflect.DeepEqual(a, b) {
		return true
	}
	as, aok := a.(string)
	bs, bok := b.(string)
	if !aok || !bok {
		return false
	}
	at, aerr := time.Parse(time.RFC3339, as)
	bt, berr := time.Parse(time.RFC3339, bs)
	return aerr == nil && berr == nil && at.Equal(bt)
}

// RefuseDelete handles DELETE /api/v1/event_booking/:id: a booking holds
// seats, so it is cancelled (freeing them), never deleted.
func (h *Handler) RefuseDelete(*echo.Context) error {
	return echo.NewHTTPError(http.StatusConflict, "cancel the booking instead")
}

// DeleteSession handles DELETE /api/v1/event_session/:id in place of the
// generic delete: one conditional soft delete, so there's no check-then-act
// window. seats_taken (kept in step with confirmed bookings by the booking
// service) sits on the row itself, so a booking committed while this waits
// on the row lock is seen when READ COMMITTED re-evaluates the WHERE; a
// booking arriving after finds deleted_at set and fails.
func (h *Handler) DeleteSession(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}
	var deleted bool
	err = h.db.QueryRow(ctx, `
		WITH del AS (
			UPDATE event_session SET deleted_at = now(), updated_at = now()
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND seats_taken = 0
			RETURNING true AS deleted)
		SELECT deleted FROM del
		UNION ALL
		SELECT false FROM event_session
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM del)`, id, tenant).Scan(&deleted)
	if isNoRows(err) {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	if err != nil {
		return err
	}
	if !deleted {
		return echo.NewHTTPError(http.StatusConflict, "the session has confirmed bookings; cancel them first")
	}
	return c.NoContent(http.StatusNoContent)
}

// GuardSessionUpdate sits in front of the generic event_session update: a
// session never changes event (its bookings carry the event id, and the
// generic layer doesn't check the new target's tenant). Sending the stored
// event_id back — the ERP form PUTs its whole draft — is fine.
func (h *Handler) GuardSessionUpdate(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		tenant, _ := access.TenantFromContext(ctx)
		id, err := echo.PathParam[uuid.UUID](c, "id")
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
		}
		raw, err := io.ReadAll(c.Request().Body)
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "unreadable body")
		}
		c.Request().Body = io.NopCloser(bytes.NewReader(raw))
		var body struct {
			EventID *string `json:"event_id"`
		}
		if json.Unmarshal(raw, &body) != nil || body.EventID == nil {
			return next(c) // malformed or no event_id: the generic handler decides
		}
		var stored uuid.UUID
		err = h.db.QueryRow(ctx, `SELECT event_id FROM event_session WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
			id, tenant).Scan(&stored)
		if isNoRows(err) {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		if err != nil {
			return err
		}
		if want, err := uuid.Parse(*body.EventID); err != nil || want != stored {
			return echo.NewHTTPError(http.StatusBadRequest, "event_id cannot be changed; create a session on the other event instead")
		}
		return next(c)
	}
}
