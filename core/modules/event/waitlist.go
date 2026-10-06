package event

import (
	"context"
	"fmt"
	"time"

	eerpmail "core/internal/mail"
	"core/internal/settings"
	"core/orm"

	"github.com/google/uuid"
)

// Waiting list (sessions only). A waitlisted booking holds no seat. Whenever
// seats free up — a cancel, a capacity increase, an expired offer — offerNext
// gives the oldest waitlisted entries that fit a claim offer: a token emailed
// as a link, valid for the tenant's waitlist_claim_hours. An offer reserves
// nothing: claiming books through the same guarded seat capture as any
// booking, so a faster visitor wins and the claim is a 409 (the entry stays
// on the list). An unclaimed offer ends as expired and passes the seat on.

// offerNext offers sessionID's free seats, not already promised to an open
// offer, to its waiting list in arrival order — skipping an entry whose seats
// don't fit. Runs in the caller's transaction; the session row lock
// serializes concurrent callers.
func (s *Service) offerNext(ctx context.Context, tx *orm.Tx, tenant, sessionID uuid.UUID) error {
	var free int
	var start time.Time
	err := tx.QueryRow(ctx, `SELECT capacity - seats_taken, starts_at FROM event_session
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, sessionID, tenant).Scan(&free, &start)
	if isNoRows(err) || (err == nil && !start.After(time.Now())) {
		return nil // deleted or past: nothing to offer
	}
	if err != nil {
		return err
	}
	var promised int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(seats), 0) FROM event_booking
		WHERE session_id = $1 AND status = $2 AND offer_expires_at > now() AND deleted_at IS NULL`,
		sessionID, BookingWaitlisted).Scan(&promised); err != nil {
		return err
	}
	free -= promised
	if free <= 0 {
		return nil
	}
	cfg, err := loadSettings(ctx, settings.NewRepository(s.db), tenant)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id, event_id, seats, email, name, user_id, cancel_token FROM event_booking
		WHERE session_id = $1 AND status = $2 AND offer_expires_at IS NULL AND deleted_at IS NULL
		ORDER BY created_at FOR UPDATE`, sessionID, BookingWaitlisted)
	if err != nil {
		return err
	}
	var waiting []EventBooking
	for rows.Next() {
		var b EventBooking
		if err := rows.Scan(&b.ID, &b.EventID, &b.Seats, &b.Email, &b.Name, &b.UserID, &b.CancelToken); err != nil {
			rows.Close()
			return err
		}
		waiting = append(waiting, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, b := range waiting {
		if b.Seats > free {
			continue
		}
		token, err := randomToken()
		if err != nil {
			return err
		}
		expires := time.Now().Add(time.Duration(cfg.WaitlistClaimHours) * time.Hour)
		if _, err := tx.Exec(ctx, `UPDATE event_booking SET offer_token = $2, offer_expires_at = $3, updated_at = now() WHERE id = $1`,
			b.ID, token, expires); err != nil {
			return err
		}
		ev := Event{TenantID: tenant}
		if err := tx.QueryRow(ctx, `SELECT name, location, timezone FROM event WHERE id = $1`, b.EventID).
			Scan(&ev.Name, &ev.Location, &ev.Timezone); err != nil {
			return err
		}
		msg, err := bookingEmail(ctx, tx, TemplateOffer, ev, b, start, s.siteURL, func(locale string, loc *time.Location) map[string]string {
			return map[string]string{
				"claim_url": s.siteURL + "/booking/claim?token=" + token,
				"expires":   eerpmail.FormatDateTime(expires.In(loc), locale),
			}
		})
		if err != nil {
			return err
		}
		if err := eerpmail.Enqueue(ctx, tx, msg); err != nil {
			return err
		}
		if free -= b.Seats; free <= 0 {
			break
		}
	}
	return nil
}

// ClaimOffer books an open waiting-list offer by its token: ErrNotFound for
// an unknown, spent or expired token; ErrFull when the seat went to someone
// faster (the entry stays on the list, its offer spent).
func (s *Service) ClaimOffer(ctx context.Context, tenant uuid.UUID, token string) error {
	if len(token) != 64 {
		return ErrNotFound
	}
	var b EventBooking
	err := orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		err := tx.QueryRow(ctx, `SELECT id, event_id, session_id, seats, email, name, user_id, contact_id, cancel_token FROM event_booking
			WHERE tenant_id = $1 AND offer_token = $2 AND status = $3 AND offer_expires_at > now() AND deleted_at IS NULL FOR UPDATE`,
			tenant, token, BookingWaitlisted).Scan(&b.ID, &b.EventID, &b.SessionID, &b.Seats, &b.Email, &b.Name, &b.UserID, &b.ContactID, &b.CancelToken)
		if isNoRows(err) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		ev, err := orm.MustRepo[Event](tx).FindOne(ctx, orm.Cond("id = $1 AND tenant_id = $2", b.EventID, tenant))
		if isNoRows(err) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		when, err := captureSessionSeats(ctx, tx, ev, *b.SessionID, b.Seats)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE event_booking SET status = $2, offer_token = '', offer_expires_at = NULL, starts_at = $3, updated_at = now()
			WHERE id = $1`, b.ID, BookingConfirmed, when); err != nil {
			return err
		}
		due, err := s.charge(ctx, tx, ev, &b)
		if err != nil {
			return err
		}
		msg, err := confirmationEmail(ctx, tx, ev, b, when, s.siteURL, due)
		if err != nil {
			return err
		}
		return eerpmail.Enqueue(ctx, tx, msg)
	})
	if err == ErrFull { //nolint:errorlint // captureSessionSeats returns the sentinel itself
		// Spend the offer: the link must not keep failing; the entry waits for the next seat.
		_, _ = s.db.Exec(ctx, `UPDATE event_booking SET offer_token = '', offer_expires_at = NULL, updated_at = now() WHERE id = $1`, b.ID)
	}
	if err == nil {
		s.log(ctx, tenant, b.EventID, b.Email, fmt.Sprintf("Waiting list claimed: %s, %d seat(s)", b.Name, b.Seats))
	}
	return err
}

// ExpireOffers ends every open offer past its deadline (status expired) and
// offers the seats to the next in line. Runs from the event sweep.
func (s *Service) ExpireOffers(ctx context.Context) error {
	return orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		rows, err := tx.Query(ctx, `UPDATE event_booking SET status = $2, offer_token = '', updated_at = now()
			WHERE status = $1 AND offer_expires_at <= now() AND deleted_at IS NULL
			RETURNING tenant_id, session_id`, BookingWaitlisted, BookingExpired)
		if err != nil {
			return err
		}
		type sess struct{ tenant, id uuid.UUID }
		seen := map[sess]bool{}
		for rows.Next() {
			var t uuid.UUID
			var id *uuid.UUID
			if err := rows.Scan(&t, &id); err != nil {
				rows.Close()
				return err
			}
			if id != nil {
				seen[sess{t, *id}] = true
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for k := range seen {
			if err := s.offerNext(ctx, tx, k.tenant, k.id); err != nil {
				return err
			}
		}
		return nil
	})
}
