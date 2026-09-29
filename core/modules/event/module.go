// Package event is the bookable-events model: events with fixed sessions or
// weekly-availability appointment slots, and their bookings.
package event

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&eventModule{})
}

type eventModule struct{}

func (m *eventModule) Name() string { return "event" }

func (m *eventModule) Register() error {
	if err := orm.Register[Event](orm.WithTableName("event"),
		orm.WithPublicFields("name", "description", "location", "kind", "slot_minutes", "timezone")); err != nil {
		return err
	}
	if err := orm.Register[EventSession](orm.WithTableName("event_session"), orm.WithReadOnlyFields("seats_taken")); err != nil {
		return err
	}
	if err := orm.Register[EventAvailability](orm.WithTableName("event_availability")); err != nil {
		return err
	}
	// cancel_token never leaves Go: excluded from the API entirely.
	return orm.Register[EventBooking](orm.WithTableName("event_booking"), orm.WithExcludeFields("cancel_token"))
}

// Migrate adds the constraints struct tags can't express.
func (m *eventModule) Migrate(ctx context.Context, db *orm.DB) error {
	for _, stmt := range []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_booking_cancel_token ON event_booking (cancel_token) WHERE cancel_token <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_event_booking_slot ON event_booking (event_id, slot_start) WHERE status = 'confirmed'`,
		`DO $$ BEGIN
			ALTER TABLE event_booking ADD CONSTRAINT event_booking_one_target
			CHECK ((session_id IS NULL) <> (slot_start IS NULL));
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN
			ALTER TABLE event_session ADD CONSTRAINT event_session_seats
			CHECK (seats_taken >= 0);
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		// Staff can't shrink a session below its booked seats (400 via the
		// generic handler's check-violation mapping), even racing a booking.
		`DO $$ BEGIN
			ALTER TABLE event_session ADD CONSTRAINT event_session_capacity
			CHECK (seats_taken <= capacity);
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
	} {
		if _, err := db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("event: migrate: %w", err)
		}
	}
	return nil
}
