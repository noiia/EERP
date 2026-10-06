package event

import (
	"time"

	"core/orm/model"

	"github.com/google/uuid"
)

const (
	KindSessions     = "sessions"
	KindAppointment  = "appointment"
	BookingConfirmed = "confirmed"
	BookingCancelled = "cancelled"
	// Check-in outcomes, set by staff from 1 h before the start. Both keep
	// their seats: every capacity count holds all bookings but cancelled ones.
	BookingAttended = "attended"
	BookingNoShow   = "no_show"
	// Waiting list (sessions only): a waitlisted booking holds no seat. When
	// seats free up the oldest entry that fits gets a time-limited claim
	// offer (offer_token); an unclaimed offer ends as expired.
	BookingWaitlisted = "waitlisted"
	BookingExpired    = "expired"
	// BookingPendingPayment holds its seats while the booker pays online
	// (until hold_expires_at); the payment webhook confirms it, the sweep
	// releases it.
	BookingPendingPayment = "pending_payment"
)

// Optional columns are pointers: the generic CRUD layer requires every
// non-pointer column on create (ValidateEventBody fills the event defaults).

// Event is something bookable: fixed sessions (KindSessions) or appointment
// slots computed from weekly availability (KindAppointment).
type Event struct {
	model.BaseModel
	TenantID           uuid.UUID `db:"tenant_id"`
	Name               string    `db:"name" json:"name"`
	Description        *string   `db:"description" json:"description"`
	Location           *string   `db:"location" json:"location"`
	Published          *bool     `db:"published" json:"published"`
	Kind               string    `db:"kind" json:"kind"`
	Timezone           string    `db:"timezone" json:"timezone"`
	SlotMinutes        int       `db:"slot_minutes" json:"slot_minutes"`
	SlotCapacity       int       `db:"slot_capacity" json:"slot_capacity"`
	BufferMinutes      *int      `db:"buffer_minutes" json:"buffer_minutes"`
	BookingHorizonDays int       `db:"booking_horizon_days" json:"booking_horizon_days"`
	MinNoticeHours     int       `db:"min_notice_hours" json:"min_notice_hours"`
	MaxSeatsPerBooking int       `db:"max_seats_per_booking" json:"max_seats_per_booking"`
	// Picture is the flag behind the form's boolean/picture widget: true ⇔ a
	// picture exists on the (event, record, picture) anchor; the picture
	// service owns the bytes. Public-capable like every event column.
	Picture *bool `db:"picture" json:"picture"`
	// ProductVariantID makes bookings paid: the sale variant whose price and
	// taxes a booking's invoice carries (a session's price overrides the unit
	// price). Unset: bookings are free and a session price is display only.
	ProductVariantID *uuid.UUID `db:"product_variant_id" json:"product_variant_id"`
}

// EventSession's window is starts_at/ends_at: the ORM does not quote
// identifiers and "end" is a reserved word in Postgres.
type EventSession struct {
	model.BaseModel
	TenantID   uuid.UUID `db:"tenant_id"`
	EventID    uuid.UUID `db:"event_id,index" json:"event_id"`
	StartsAt   time.Time `db:"starts_at" json:"starts_at"`
	EndsAt     time.Time `db:"ends_at" json:"ends_at"`
	Capacity   int       `db:"capacity" json:"capacity"`
	SeatsTaken int       `db:"seats_taken" json:"seats_taken"`
	Price      *float64  `db:"price" json:"price"` // display only
}

// EventAvailability: local wall-clock hours ("09:00") on a weekday (0 = Sunday).
type EventAvailability struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	EventID  uuid.UUID `db:"event_id,index" json:"event_id"`
	Weekday  int       `db:"weekday" json:"weekday"`
	FromTime string    `db:"from_time" json:"from_time"`
	ToTime   string    `db:"to_time" json:"to_time"`
}

type EventBooking struct {
	model.BaseModel
	TenantID  uuid.UUID  `db:"tenant_id"`
	EventID   uuid.UUID  `db:"event_id,index" json:"event_id"`
	SessionID *uuid.UUID `db:"session_id,index" json:"session_id"`
	SlotStart *time.Time `db:"slot_start" json:"slot_start"`
	SlotEnd   *time.Time `db:"slot_end" json:"slot_end"`
	Seats     int        `db:"seats" json:"seats"`
	Email     string     `db:"email" json:"email"`
	Name      string     `db:"name" json:"name"`
	Phone     *string    `db:"phone" json:"phone"`
	ContactID *uuid.UUID `db:"contact_id" json:"contact_id"`
	UserID    *uuid.UUID `db:"user_id,index" json:"user_id"`
	Status    string     `db:"status" json:"status"`
	// StartsAt is the booked session's start or the slot start, copied so the
	// bookings calendar has one date column: the booking service writes it, a
	// session's start edit re-syncs it (SyncSessionStart), Migrate heals drift.
	StartsAt *time.Time `db:"starts_at,index" json:"starts_at"`
	// InvoiceID is the sale invoice of a paid booking (sale.CreateInvoice).
	InvoiceID *uuid.UUID `db:"invoice_id" json:"invoice_id"`
	// PaidAt: when the invoice was paid — online (payment webhook) or at the
	// event (staff "Mark paid", which sets it through the booking PUT).
	PaidAt *time.Time `db:"paid_at" json:"paid_at"`
	// HoldExpiresAt: a pending payment's deadline.
	HoldExpiresAt *time.Time `db:"hold_expires_at" json:"hold_expires_at"`
	// ReminderSentAt stamps the reminder email (Service.SendReminders), so it goes out once.
	ReminderSentAt *time.Time `db:"reminder_sent_at" json:"reminder_sent_at"`
	CancelToken    string     `db:"cancel_token" json:"-"`
	// OfferToken/OfferExpiresAt: a waitlisted booking's open claim offer
	// (offerNext); "" / nil while it waits. The token never leaves Go except
	// in the offer email.
	OfferToken     string     `db:"offer_token" json:"-"`
	OfferExpiresAt *time.Time `db:"offer_expires_at" json:"offer_expires_at"`
	CancelledAt    *time.Time `db:"cancelled_at" json:"cancelled_at"`
}
