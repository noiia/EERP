// Package event is the bookable-events model: events with fixed sessions or
// weekly-availability appointment slots, and their bookings.
package event

import (
	"context"
	"fmt"

	"core/internal/common"
	"core/internal/module"
	"core/orm"

	"go.uber.org/zap"
)

func init() {
	module.RegisterGoModule(&eventModule{})
}

type eventModule struct{}

func (m *eventModule) Name() string { return "event" }

func (m *eventModule) Register() error {
	if err := orm.Register[Event](orm.WithTableName("event"),
		orm.WithPublicFields(orm.AllPublicFields)); err != nil {
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

// checks are the CHECK constraints struct tags can't express.
var checks = []struct{ table, name, expr string }{
	{"event_booking", "event_booking_one_target", "(session_id IS NULL) <> (slot_start IS NULL)"},
	{"event_session", "event_session_seats", "seats_taken >= 0"},
	// Staff can't shrink a session below its booked seats (400 via the
	// generic handler's check-violation mapping), even racing a booking.
	{"event_session", "event_session_capacity", "seats_taken <= capacity"},
	// ValidateSessionBody only sees the keys a PUT carries; this also
	// catches a partial update inverting the stored window.
	{"event_session", "event_session_window", "ends_at > starts_at"},
}

// Migrate adds the constraints struct tags can't express. CHECKs are added
// NOT VALID — enforced on every new or updated row, but an old violating row
// can't fail boot — then validated best-effort (a failure is only logged).
func (m *eventModule) Migrate(ctx context.Context, db *orm.DB) error {
	for _, stmt := range []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_booking_cancel_token ON event_booking (cancel_token) WHERE cancel_token <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_event_booking_slot ON event_booking (event_id, slot_start) WHERE status = 'confirmed'`,
	} {
		if _, err := db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("event: migrate: %w", err)
		}
	}
	for _, c := range checks {
		if _, err := db.Exec(ctx, `DO $$ BEGIN
			ALTER TABLE `+c.table+` ADD CONSTRAINT `+c.name+` CHECK (`+c.expr+`) NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`); err != nil {
			return fmt.Errorf("event: migrate: %w", err)
		}
		if _, err := db.Exec(ctx, `ALTER TABLE `+c.table+` VALIDATE CONSTRAINT `+c.name); err != nil {
			common.Logger.Warn("event: existing rows violate a constraint; it only applies to new writes until they're fixed",
				zap.String("constraint", c.name), zap.Error(err))
		}
	}
	return nil
}
