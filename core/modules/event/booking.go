package event

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"core/internal/chatter"
	"core/internal/common"
	eerpmail "core/internal/mail"
	"core/modules/contact"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

var (
	ErrFull        = errors.New("no seats left")
	ErrNotBookable = errors.New("not bookable")
	ErrBadRequest  = errors.New("invalid booking")
	ErrNotFound    = errors.New("booking not found")
)

// BookRequest targets exactly one of a session (SessionID) or an appointment
// slot (SlotStart).
type BookRequest struct {
	EventID   uuid.UUID
	SessionID *uuid.UUID
	SlotStart *time.Time
	Seats     int
	Email     string
	Name      string
	Phone     string
	// Never bound from a request body: handlers set these from the
	// authenticated identity / the ERP route.
	UserID *uuid.UUID `json:"-"`
	Staff  bool       `json:"-"` // ERP-side booking: unpublished events allowed
}

type SlotAvailability struct {
	Start     time.Time `json:"start"`
	End       time.Time `json:"end"`
	SeatsLeft int       `json:"seats_left"`
}

// Service is the transactional core of event booking.
type Service struct {
	db      *orm.DB
	chat    *chatter.Repository
	siteURL string
}

func NewService(db *orm.DB, chat *chatter.Repository, siteURL string) *Service {
	return &Service{db: db, chat: chat, siteURL: strings.TrimRight(siteURL, "/")}
}

func isNoRows(err error) bool { return errors.Is(err, orm.ErrNotFound) }

// Book captures seats, links the account's contact (if any), inserts the booking and queues its
// confirmation email — one transaction, so a failure anywhere leaves no trace.
func (s *Service) Book(ctx context.Context, tenant uuid.UUID, req BookRequest) (EventBooking, error) {
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Name, req.Phone = strings.TrimSpace(req.Name), strings.TrimSpace(req.Phone)
	if a, err := mail.ParseAddress(req.Email); err != nil || a.Address != req.Email {
		return EventBooking{}, fmt.Errorf("%w: invalid email", ErrBadRequest)
	}
	if req.Name == "" || len(req.Name) > 200 || len(req.Phone) > 50 {
		return EventBooking{}, fmt.Errorf("%w: name is required (max 200), phone max 50", ErrBadRequest)
	}
	if (req.SessionID == nil) == (req.SlotStart == nil) {
		return EventBooking{}, fmt.Errorf("%w: give exactly one of session_id or slot_start", ErrBadRequest)
	}
	ev, err := orm.MustRepo[Event](s.db).FindOne(ctx,
		orm.Cond("id = $1 AND tenant_id = $2 AND (published IS TRUE OR $3)", req.EventID, tenant, req.Staff))
	if isNoRows(err) {
		return EventBooking{}, ErrNotBookable
	}
	if err != nil {
		return EventBooking{}, err
	}
	if req.Seats < 1 || req.Seats > ev.MaxSeatsPerBooking {
		return EventBooking{}, fmt.Errorf("%w: seats must be 1 to %d", ErrBadRequest, ev.MaxSeatsPerBooking)
	}
	token, err := randomToken()
	if err != nil {
		return EventBooking{}, err
	}
	b := EventBooking{TenantID: tenant, EventID: ev.ID, SessionID: req.SessionID, Seats: req.Seats,
		Email: req.Email, Name: req.Name, UserID: req.UserID, Status: BookingConfirmed, CancelToken: token}
	if req.Phone != "" {
		b.Phone = &req.Phone
	}
	var when time.Time
	err = orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		var err error
		if req.SessionID != nil {
			if ev.Kind != KindSessions {
				return ErrNotBookable
			}
			if when, err = captureSessionSeats(ctx, tx, ev, *req.SessionID, req.Seats); err != nil {
				return err
			}
		} else {
			slot, err := captureSlot(ctx, tx, ev, *req.SlotStart, req.Seats)
			if err != nil {
				return err
			}
			b.SlotStart, b.SlotEnd, when = &slot.Start, &slot.End, slot.Start
		}
		if b.ContactID, err = accountContact(ctx, tx, tenant, req.UserID); err != nil {
			return err
		}
		if b, err = orm.MustRepo[EventBooking](tx).Create(ctx, b); err != nil {
			return err
		}
		msg, err := confirmationEmail(ev, b, when, s.siteURL)
		if err != nil {
			return err
		}
		msg.TenantID = tenant
		return eerpmail.Enqueue(ctx, tx, msg)
	})
	if err != nil {
		return EventBooking{}, err
	}
	s.log(ctx, tenant, ev.ID, req.Email, fmt.Sprintf("Booking: %s, %d seat(s), %s", req.Name, req.Seats, when.Format(time.RFC3339)))
	return b, nil
}

// captureSessionSeats: one guarded UPDATE — atomic under concurrency (the row
// lock re-evaluates the WHERE for a waiting writer), no lock table; 0 rows =
// full, past, or not this event's session.
func captureSessionSeats(ctx context.Context, tx *orm.Tx, ev Event, sessionID uuid.UUID, seats int) (time.Time, error) {
	var start time.Time
	err := tx.QueryRow(ctx, `
		UPDATE event_session SET seats_taken = seats_taken + $3, updated_at = now()
		WHERE id = $1 AND event_id = $2 AND tenant_id = $4 AND deleted_at IS NULL
		  AND seats_taken + $3 <= capacity AND starts_at > now()
		RETURNING starts_at`, sessionID, ev.ID, seats, ev.TenantID).Scan(&start)
	if err == nil {
		return start, nil
	}
	if !isNoRows(err) {
		return time.Time{}, err
	}
	var belongs bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM event_session WHERE id = $1 AND event_id = $2 AND tenant_id = $3 AND deleted_at IS NULL)`,
		sessionID, ev.ID, ev.TenantID).Scan(&belongs); err != nil {
		return time.Time{}, err
	}
	if !belongs {
		return time.Time{}, ErrNotBookable
	}
	return time.Time{}, ErrFull
}

// captureSlot re-validates the slot against the availability (a client can't
// invent one), serializes on (event, slot) with a transaction-scoped advisory
// lock — there's no row to lock for a slot nobody has booked yet — then counts.
// The count runs after the lock, so under READ COMMITTED it sees every booking
// committed by the previous lock holder.
func captureSlot(ctx context.Context, tx *orm.Tx, ev Event, start time.Time, seats int) (Slot, error) {
	if ev.Kind != KindAppointment {
		return Slot{}, ErrNotBookable
	}
	rules, err := RulesFor(ev)
	if err != nil {
		return Slot{}, err
	}
	avail, err := orm.MustRepo[EventAvailability](tx).FindAll(ctx, orm.Cond("event_id = $1", ev.ID))
	if err != nil {
		return Slot{}, err
	}
	day := start.In(rules.Loc)
	dayStart := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, rules.Loc)
	var slot *Slot
	for _, sl := range ExpandSlots(rules, avail, dayStart, dayStart.AddDate(0, 0, 1), time.Now()) {
		if sl.Start.Equal(start) {
			slot = &sl
			break
		}
	}
	if slot == nil {
		return Slot{}, ErrNotBookable
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		ev.ID.String()+"|"+start.UTC().Format(time.RFC3339)); err != nil {
		return Slot{}, err
	}
	var taken int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(sum(seats), 0) FROM event_booking
		WHERE event_id = $1 AND slot_start = $2 AND status = $3 AND deleted_at IS NULL`,
		ev.ID, start, BookingConfirmed).Scan(&taken); err != nil {
		return Slot{}, err
	}
	if taken+seats > ev.SlotCapacity {
		return Slot{}, ErrFull
	}
	return *slot, nil
}

// accountContact is the website contact of the booking account (created at
// signup, contact.website = true), or nil: an anonymous or staff booking is
// just its name, email and phone — it creates no contact.
func accountContact(ctx context.Context, tx *orm.Tx, tenant uuid.UUID, userID *uuid.UUID) (*uuid.UUID, error) {
	if userID == nil {
		return nil, nil
	}
	var email string
	err := tx.QueryRow(ctx, `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`, *userID, tenant).Scan(&email)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	id, err := contact.WebsiteContactID(ctx, tx, tenant, email)
	if err != nil || id == uuid.Nil {
		return nil, err
	}
	return &id, nil
}

// CancelByToken cancels via the emailed link. Idempotent: an already
// cancelled booking returns nil without freeing seats again.
func (s *Service) CancelByToken(ctx context.Context, tenant uuid.UUID, token string) error {
	if len(token) != 64 {
		return ErrNotFound
	}
	return s.cancel(ctx, tenant, `cancel_token = $2`, token)
}

// CancelByID cancels as the owner (ownerID) or as staff (ownerID nil).
func (s *Service) CancelByID(ctx context.Context, tenant, id uuid.UUID, ownerID *uuid.UUID) error {
	if ownerID != nil {
		return s.cancel(ctx, tenant, `id = $2 AND user_id = $3`, id, *ownerID)
	}
	return s.cancel(ctx, tenant, `id = $2`, id)
}

// cancel locks the booking row (FOR UPDATE) so two concurrent cancels
// serialize and only the first frees the seats.
func (s *Service) cancel(ctx context.Context, tenant uuid.UUID, where string, args ...any) error {
	var b EventBooking
	var eventName string
	var already bool
	err := orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		err := tx.QueryRow(ctx, `
			SELECT id, event_id, session_id, seats, email, name, status FROM event_booking
			WHERE tenant_id = $1 AND deleted_at IS NULL AND `+where+` FOR UPDATE`, append([]any{tenant}, args...)...).
			Scan(&b.ID, &b.EventID, &b.SessionID, &b.Seats, &b.Email, &b.Name, &b.Status)
		if isNoRows(err) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if b.Status == BookingCancelled {
			already = true
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE event_booking SET status = $2, cancelled_at = now(), updated_at = now() WHERE id = $1`,
			b.ID, BookingCancelled); err != nil {
			return err
		}
		if b.SessionID != nil {
			if _, err := tx.Exec(ctx, `UPDATE event_session SET seats_taken = seats_taken - $2, updated_at = now() WHERE id = $1`,
				*b.SessionID, b.Seats); err != nil {
				return err
			}
		}
		if err := tx.QueryRow(ctx, `SELECT name FROM event WHERE id = $1`, b.EventID).Scan(&eventName); err != nil {
			return err
		}
		msg, err := cancellationEmail(eventName, b)
		if err != nil {
			return err
		}
		msg.TenantID = tenant
		return eerpmail.Enqueue(ctx, tx, msg)
	})
	if err == nil && !already {
		s.log(ctx, tenant, b.EventID, b.Email, fmt.Sprintf("Cancelled: %s, %d seat(s)", b.Name, b.Seats))
	}
	return err
}

// Slots lists bookable slots of a published appointment event in [from, to).
func (s *Service) Slots(ctx context.Context, tenant, eventID uuid.UUID, from, to time.Time) ([]SlotAvailability, error) {
	if to.Sub(from) > 31*24*time.Hour || !to.After(from) {
		return nil, fmt.Errorf("%w: range must be positive and at most 31 days", ErrBadRequest)
	}
	ev, err := orm.MustRepo[Event](s.db).FindOne(ctx, orm.Cond("id = $1 AND tenant_id = $2 AND published IS TRUE", eventID, tenant))
	if isNoRows(err) || (err == nil && ev.Kind != KindAppointment) {
		return nil, ErrNotBookable
	}
	if err != nil {
		return nil, err
	}
	rules, err := RulesFor(ev)
	if err != nil {
		return nil, err
	}
	avail, err := orm.MustRepo[EventAvailability](s.db).FindAll(ctx, orm.Cond("event_id = $1", ev.ID))
	if err != nil {
		return nil, err
	}
	taken := map[time.Time]int{}
	rows, err := s.db.Query(ctx, `
		SELECT slot_start, sum(seats) FROM event_booking
		WHERE event_id = $1 AND status = $2 AND deleted_at IS NULL AND slot_start >= $3 AND slot_start < $4
		GROUP BY slot_start`, ev.ID, BookingConfirmed, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var at time.Time
		var n int
		if err := rows.Scan(&at, &n); err != nil {
			return nil, err
		}
		taken[at.UTC()] = n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []SlotAvailability{}
	for _, sl := range ExpandSlots(rules, avail, from, to, time.Now()) {
		if left := ev.SlotCapacity - taken[sl.Start.UTC()]; left > 0 {
			out = append(out, SlotAvailability{Start: sl.Start, End: sl.End, SeatsLeft: left})
		}
	}
	return out, nil
}

// log posts to the event's chatter after commit; best-effort (a lost log
// entry must never fail a booking).
func (s *Service) log(ctx context.Context, tenant, eventID uuid.UUID, email, body string) {
	_, err := s.chat.Create(ctx, chatter.ChatterMessage{BaseModel: model.BaseModel{TenantID: tenant},
		TableName: "event", RecordID: eventID, AuthorEmail: email, Kind: "log", Body: body})
	if err != nil {
		common.Logger.Warn("event: chatter log", zap.Error(err))
	}
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// AttachBookings gives a just-verified website user (website.AttachFunc) the
// anonymous bookings made earlier with the same address in their tenant —
// never someone else's: the address is now proven theirs, and rows already
// owned by an account (user_id set) are left alone. Every status attaches:
// cancelled bookings are history too.
// They also take the account's website contact, as a logged-in booking does.
func AttachBookings(ctx context.Context, tx *orm.Tx, tenant, userID uuid.UUID, email string) error {
	cid, err := contact.WebsiteContactID(ctx, tx, tenant, email)
	if err != nil {
		return err
	}
	var contactID *uuid.UUID
	if cid != uuid.Nil {
		contactID = &cid
	}
	_, err = tx.Exec(ctx, `UPDATE event_booking SET user_id = $3, contact_id = COALESCE($4, contact_id), updated_at = now()
		WHERE tenant_id = $1 AND lower(email) = lower($2) AND user_id IS NULL AND deleted_at IS NULL`, tenant, email, userID, contactID)
	return err
}
