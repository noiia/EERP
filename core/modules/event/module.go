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
	// Staff calendar feed tokens: off the generic CRUD surface (FeedHandler).
	if err := orm.Register[EventFeed](orm.WithTableName("event_feed"), orm.WithExcluded()); err != nil {
		return err
	}
	// cancel_token and offer_token never leave Go: excluded from the API entirely.
	return orm.Register[EventBooking](orm.WithTableName("event_booking"), orm.WithExcludeFields("cancel_token", "offer_token"))
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
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_booking_offer_token ON event_booking (offer_token) WHERE offer_token <> ''`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_feed_token ON event_feed (token_hash)`,
		// Slot capacity counts every booking but cancelled ones (a checked-in
		// booking keeps its seats); this replaces the confirmed-only index.
		`DROP INDEX IF EXISTS idx_event_booking_slot`,
		`CREATE INDEX IF NOT EXISTS idx_event_booking_slot_held ON event_booking (event_id, slot_start) WHERE status <> 'cancelled'`,
		// The reminder sweep scans confirmed, not-yet-reminded bookings by start.
		`CREATE INDEX IF NOT EXISTS idx_event_booking_reminder_due ON event_booking (starts_at)
		 WHERE status = 'confirmed' AND reminder_sent_at IS NULL AND deleted_at IS NULL`,
		// starts_at: backfill rows from before the column, and heal any drift a
		// crash between a session update and its SyncSessionStart left behind.
		`UPDATE event_booking b SET starts_at = s.starts_at FROM event_session s
		 WHERE b.session_id = s.id AND b.starts_at IS DISTINCT FROM s.starts_at`,
		`UPDATE event_booking SET starts_at = slot_start
		 WHERE session_id IS NULL AND starts_at IS DISTINCT FROM slot_start`,
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
	if err := backfillContacts(ctx, db); err != nil {
		return err
	}
	return seedPresets(ctx, db)
}

// backfillContacts links bookings made before every booking had a contact
// (contact.FindOrCreate's rule, set-based): a contact is created for each
// booker email no contact has yet, then each unlinked booking takes the
// website contact of its email, else the oldest one. Idempotent: a no-op
// once every booking is linked. Skipped while the contact table is missing.
func backfillContacts(ctx context.Context, db *orm.DB) error {
	var ready bool
	if err := db.QueryRow(ctx, `SELECT to_regclass('contact') IS NOT NULL`).Scan(&ready); err != nil || !ready {
		return err
	}
	for _, stmt := range []string{`
		INSERT INTO contact (tenant_id, name, email, company, status)
		SELECT DISTINCT ON (b.tenant_id, lower(b.email)) b.tenant_id, b.name, lower(b.email), '', 'customer'
		FROM event_booking b
		WHERE b.contact_id IS NULL AND b.deleted_at IS NULL AND b.email <> ''
		  AND NOT EXISTS (SELECT 1 FROM contact c WHERE c.tenant_id = b.tenant_id AND lower(c.email) = lower(b.email) AND c.deleted_at IS NULL)
		ORDER BY b.tenant_id, lower(b.email), b.created_at`, `
		UPDATE event_booking b SET contact_id = (
			SELECT c.id FROM contact c WHERE c.tenant_id = b.tenant_id AND lower(c.email) = lower(b.email) AND c.deleted_at IS NULL
			ORDER BY c.website IS TRUE DESC, c.created_at LIMIT 1)
		WHERE b.contact_id IS NULL AND b.deleted_at IS NULL AND b.email <> ''`,
	} {
		if _, err := db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("event: backfill booking contacts: %w", err)
		}
	}
	return nil
}
