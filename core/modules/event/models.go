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
	TenantID    uuid.UUID  `db:"tenant_id"`
	EventID     uuid.UUID  `db:"event_id,index" json:"event_id"`
	SessionID   *uuid.UUID `db:"session_id,index" json:"session_id"`
	SlotStart   *time.Time `db:"slot_start" json:"slot_start"`
	SlotEnd     *time.Time `db:"slot_end" json:"slot_end"`
	Seats       int        `db:"seats" json:"seats"`
	Email       string     `db:"email" json:"email"`
	Name        string     `db:"name" json:"name"`
	Phone       *string    `db:"phone" json:"phone"`
	ContactID   *uuid.UUID `db:"contact_id" json:"contact_id"`
	UserID      *uuid.UUID `db:"user_id,index" json:"user_id"`
	Status      string     `db:"status" json:"status"`
	CancelToken string     `db:"cancel_token" json:"-"`
	CancelledAt *time.Time `db:"cancelled_at" json:"cancelled_at"`
}
