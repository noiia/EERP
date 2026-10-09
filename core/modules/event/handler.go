package event

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"core/internal/auth"
	"core/modules/sale"
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
	type row struct {
		id         uuid.UUID
		start, end time.Time
		capacity   int
		taken      int
		price      *float64
	}
	var sessions []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.start, &r.end, &r.capacity, &r.taken, &r.price); err != nil {
			return err
		}
		sessions = append(sessions, r)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	// A paid event shows what the visitor pays: the session's price, else the
	// variant's, tax included. Without a variant the price is display text as entered.
	var variantPrice float64
	var display sale.PriceDisplay
	var variantID *uuid.UUID
	if err := h.db.QueryRow(ctx, `SELECT product_variant_id FROM event WHERE id = $1`, id).Scan(&variantID); err != nil && !isNoRows(err) {
		return err
	}
	if variantID != nil {
		if variantPrice, display, err = sale.VariantPricing(ctx, h.db, tenant, *variantID); err != nil && !errors.Is(err, sale.ErrNoVariant) {
			return err
		}
	}
	out := []map[string]any{}
	for _, r := range sessions {
		price := r.price
		if display != nil {
			unit := variantPrice
			if r.price != nil {
				unit = *r.price
			}
			p := display(unit)
			price = &p
		}
		out = append(out, map[string]any{"id": r.id, "starts_at": r.start, "ends_at": r.end,
			"capacity": r.capacity, "seats_left": r.capacity - r.taken, "price": price})
	}
	currency, err := sale.WorkspaceCurrency(ctx, h.db, tenant)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"data": out, "currency": currency})
}

// PublicResolver is the public scope of a table (website.Publisher.Resolve
// wrapped by website.ActiveOnly): ok false = not published, or its module is off.
type PublicResolver func(ctx context.Context, table string) (access.PublicScope, bool, error)

// PublicUpcoming handles GET /api/v1/public/events/upcoming?limit= (1–50,
// default 12): published events with their next future session (start and
// seats left) — sessions events without one are left out, appointment events
// are listed after them (they book slots, not sessions). The event table's
// own published scope applies: 404 when unpublished, only published columns
// returned, its forced filter enforced. The site's event_list block reads it.
// ?near=<lon>,<lat> orders by distance of geo_location (when published; else
// ignored) and adds distance_m (null when unlocated); a malformed value is 400.
func (h *Handler) PublicUpcoming(resolve PublicResolver) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		tenant, _ := access.TenantFromContext(ctx)
		limit := 12
		if raw := c.QueryParam("limit"); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || n > 50 {
				return echo.NewHTTPError(http.StatusBadRequest, "limit must be 1 to 50")
			}
			limit = n
		}
		scope, ok, err := resolve(ctx, "event")
		if err != nil {
			return err
		}
		if !ok {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		distanceSQL, orderSQL := "NULL::float8", ""
		if raw := c.QueryParam("near"); raw != "" {
			lon, lat, err := orm.ParseLonLat(raw)
			if err != nil {
				return echo.NewHTTPError(http.StatusBadRequest, "near must be <longitude>,<latitude>")
			}
			if scope.Allows("geo_location") { // an unpublished location must not even order the list
				p := orm.GeoPointSQL(lon, lat)
				distanceSQL = "ST_Distance(e.geo_location, " + p + ")"
				orderSQL = "e.geo_location <-> " + p + " NULLS LAST, "
			}
		}
		args := []any{tenant, limit}
		where := ""
		for col, val := range scope.Equals {
			if !orm.TableHasColumn("event", col) { // col becomes an identifier
				continue
			}
			args = append(args, val)
			where += fmt.Sprintf(" AND e.%s::text = $%d", col, len(args))
		}
		rows, err := h.db.Query(ctx, `
			SELECT e.id, e.name, e.description, e.location, e.kind, e.timezone, e.picture, n.starts_at, n.seats_left, `+distanceSQL+` AS distance_m
			FROM event e
			LEFT JOIN LATERAL (
				SELECT s.starts_at, s.capacity - s.seats_taken AS seats_left FROM event_session s
				WHERE s.event_id = e.id AND s.tenant_id = e.tenant_id AND s.deleted_at IS NULL AND s.starts_at > now()
				ORDER BY s.starts_at LIMIT 1) n ON true
			WHERE e.tenant_id = $1 AND e.deleted_at IS NULL AND e.published IS TRUE
			  AND (e.kind = 'appointment' OR n.starts_at IS NOT NULL)`+where+`
			ORDER BY `+orderSQL+`n.starts_at NULLS LAST, e.name LIMIT $2`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var id uuid.UUID
			var name, kind, tz string
			var desc, loc *string
			var picture *bool
			var next *time.Time
			var left *int
			var dist *float64
			if err := rows.Scan(&id, &name, &desc, &loc, &kind, &tz, &picture, &next, &left, &dist); err != nil {
				return err
			}
			row := map[string]any{"id": id, "next_session_at": next, "seats_left": left}
			if orderSQL != "" {
				row["distance_m"] = dist
			}
			for col, v := range map[string]any{"name": name, "description": desc, "location": loc, "kind": kind, "timezone": tz, "picture": picture} {
				if scope.Allows(col) {
					row[col] = v
				}
			}
			out = append(out, row)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		return c.JSON(http.StatusOK, map[string]any{"data": out})
	}
}

// httpErr maps the booking service's errors. Not-bookable and not-found share
// one 404 so a caller can't probe which events or tokens exist.
func httpErr(err error) error {
	switch {
	case errors.Is(err, ErrFull):
		return echo.NewHTTPError(http.StatusConflict, "no seats left")
	case errors.Is(err, ErrState):
		return echo.NewHTTPError(http.StatusConflict, err.Error())
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
	Waitlist  bool       `json:"waitlist"`
}

func (h *Handler) book(c *echo.Context, staff bool) (EventBooking, error) {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	var in bookBody
	if err := json.NewDecoder(c.Request().Body).Decode(&in); err != nil {
		return EventBooking{}, echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	req := BookRequest{EventID: in.EventID, SessionID: in.SessionID, SlotStart: in.SlotStart, Seats: in.Seats,
		Email: in.Email, Name: in.Name, Phone: in.Phone, Waitlist: in.Waitlist, Staff: staff}
	if id, ok := auth.IdentityFromContext(ctx); ok && !staff {
		req.UserID = &id.UserID
	}
	b, err := h.svc.Book(ctx, tenant, req)
	return b, httpErr(err)
}

// Book handles POST /api/v1/website/bookings — anonymous visitor or logged-in
// website user (then the booking is theirs). The response never says whether
// the email belongs to an account. A booking held for online payment also
// carries checkout_url, the provider's payment page; a 502 when it couldn't
// be opened (the hold is already released).
func (h *Handler) Book(c *echo.Context) error {
	b, err := h.book(c, false)
	if err != nil {
		return err
	}
	out := map[string]any{"id": b.ID, "status": b.Status}
	if b.Status == BookingPendingPayment {
		tenant, _ := access.TenantFromContext(c.Request().Context())
		url, err := h.svc.Checkout(c.Request().Context(), tenant, b.ID)
		if errors.Is(err, ErrPaymentUnavailable) {
			return echo.NewHTTPError(http.StatusBadGateway, err.Error())
		}
		if err != nil {
			return err
		}
		out["checkout_url"] = url
	}
	return c.JSON(http.StatusCreated, out)
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

// ClaimByToken handles POST /api/v1/website/bookings/claim {token} — a
// waiting-list offer's link: 404 unknown/expired/spent, 409 taken meanwhile.
func (h *Handler) ClaimByToken(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	var in struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(c.Request().Body).Decode(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if err := h.svc.ClaimOffer(ctx, tenant, in.Token); err != nil {
		return httpErr(err)
	}
	return c.JSON(http.StatusOK, map[string]any{"status": BookingConfirmed})
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
// through the service (freeing the seats), "attended"/"no_show" record the
// check-in through it (SetAttendance), and a paid_at on an unpaid booking
// marks its invoice paid (MarkPaid). Any other key must carry its
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
		cancel, attendance, markPaid := false, "", false
		for k, v := range body {
			s, isStr := v.(string)
			switch {
			case k == "name" && isStr && strings.TrimSpace(s) != "" && len(s) <= 200:
				set[k] = strings.TrimSpace(s)
			case k == "phone" && (v == nil || (isStr && len(s) <= 50)):
				set[k] = v
			case k == "status" && v == BookingCancelled && stored[k] != BookingCancelled:
				cancel = true
			case k == "status" && (v == BookingAttended || v == BookingNoShow) && stored[k] != v:
				attendance = v.(string)
			case k == "paid_at" && isStr && stored[k] == nil: // "Mark paid": the server stamps the time
				markPaid = true
			case sameValue(v, stored[k]):
			default:
				return echo.NewHTTPError(http.StatusBadRequest,
					"only name, phone, paid_at or status (cancelled, attended, no_show) can be changed; cancel and rebook for anything else ("+k+")")
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
		if attendance != "" {
			if err := h.svc.SetAttendance(ctx, tenant, id, attendance); err != nil {
				return httpErr(err)
			}
		}
		if markPaid {
			if err := h.svc.MarkPaid(ctx, tenant, id); errors.Is(err, ErrState) {
				return echo.NewHTTPError(http.StatusConflict, "this booking has no invoice")
			} else if err != nil {
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
// event_id back — the ERP form PUTs its whole draft — is fine. After a
// successful update the bookings' starts_at follow the session's start (a
// separate statement: the generic update owns its transaction; Migrate heals
// the rare drift a crash in between would leave).
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
		var body map[string]json.RawMessage
		if json.Unmarshal(raw, &body) != nil {
			return h.syncAfter(c, next, tenant, id) // malformed: the generic handler decides
		}
		sent, has := body["event_id"]
		if !has {
			return h.syncAfter(c, next, tenant, id)
		}
		var eventID string // a null or non-string event_id is a change too
		_ = json.Unmarshal(sent, &eventID)
		var stored uuid.UUID
		err = h.db.QueryRow(ctx, `SELECT event_id FROM event_session WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
			id, tenant).Scan(&stored)
		if isNoRows(err) {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		if err != nil {
			return err
		}
		if want, err := uuid.Parse(eventID); err != nil || want != stored {
			return echo.NewHTTPError(http.StatusBadRequest, "event_id cannot be changed; create a session on the other event instead")
		}
		return h.syncAfter(c, next, tenant, id)
	}
}

// syncAfter runs the generic session update, then — if it succeeded —
// re-syncs the bookings' starts_at and offers any newly free seats.
func (h *Handler) syncAfter(c *echo.Context, next echo.HandlerFunc, tenant, id uuid.UUID) error {
	if err := next(c); err != nil {
		return err
	}
	if resp, _ := echo.UnwrapResponse(c.Response()); resp != nil && resp.Status >= http.StatusMultipleChoices {
		return nil
	}
	ctx := c.Request().Context()
	if err := h.svc.SyncSessionStart(ctx, tenant, id); err != nil {
		return err
	}
	// A capacity increase frees seats for the waiting list.
	return orm.Transact(ctx, h.db, func(tx *orm.Tx) error { return h.svc.offerNext(ctx, tx, tenant, id) })
}
