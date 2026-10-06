package event

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"core/internal/common"
	eerpmail "core/internal/mail"
	"core/internal/payment"
	"core/modules/sale"
	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"go.uber.org/zap"
)

// Online payment (ADR-028). A visitor's booking of a priced event, with a
// payment provider connected, is held as pending_payment: seats captured,
// invoice "sent", no email yet. The handler then opens the provider's
// checkout (outside the booking transaction: no network call while the seat
// row is locked) and redirects the visitor there. The provider's webhook
// confirms it (invoice paid, confirmation email); a hold nobody paid is
// released by the sweep at hold_expires_at.

// holdDuration is how long a pending payment holds its seats. Stripe's
// shortest checkout expiry is 30 minutes, and the hold must outlive it.
const holdDuration = 30 * time.Minute

// ErrPaymentUnavailable: the checkout couldn't be opened; the hold is released.
var ErrPaymentUnavailable = errors.New("online payment is unavailable right now")

// PaymentReference is a booking's reference with the payment provider.
func PaymentReference(id uuid.UUID) string { return "event_booking:" + id.String() }

func holdForPayment(ctx context.Context, tx *orm.Tx, b *EventBooking) error {
	until := time.Now().Add(holdDuration)
	if _, err := tx.Exec(ctx, `UPDATE event_booking SET status = $2, hold_expires_at = $3, updated_at = now() WHERE id = $1`,
		b.ID, BookingPendingPayment, until); err != nil {
		return err
	}
	b.Status, b.HoldExpiresAt = BookingPendingPayment, &until
	return nil
}

// Checkout opens the payment page of a pending booking and returns its URL.
// On any failure the hold is released and ErrPaymentUnavailable returned.
func (s *Service) Checkout(ctx context.Context, tenant, id uuid.UUID) (string, error) {
	url, err := s.checkout(ctx, tenant, id)
	if err == nil {
		return url, nil
	}
	common.Logger.Warn("event: payment checkout", zap.String("booking", id.String()), zap.Error(err))
	if rerr := orm.Transact(ctx, s.db, func(tx *orm.Tx) error { return s.releaseHold(ctx, tx, tenant, id) }); rerr != nil {
		return "", rerr
	}
	return "", ErrPaymentUnavailable
}

func (s *Service) checkout(ctx context.Context, tenant, id uuid.UUID) (string, error) {
	prov, ok, err := payment.Available(ctx, tenant)
	if err != nil || !ok {
		return "", fmt.Errorf("no payment provider: %w", err)
	}
	var b EventBooking
	var eventName string
	var total float64
	err = s.db.QueryRow(ctx, `SELECT b.seats, b.email, b.cancel_token, b.hold_expires_at, e.name, i.total
		FROM event_booking b JOIN event e ON e.id = b.event_id JOIN invoice i ON i.id = b.invoice_id
		WHERE b.id = $1 AND b.tenant_id = $2 AND b.status = $3`, id, tenant, BookingPendingPayment).
		Scan(&b.Seats, &b.Email, &b.CancelToken, &b.HoldExpiresAt, &eventName, &total)
	if err != nil {
		return "", err
	}
	currency, err := sale.WorkspaceCurrency(ctx, s.db, tenant)
	if err != nil || currency == "" {
		return "", fmt.Errorf("no workspace currency: %w", err)
	}
	co, err := prov.Provider.CreateCheckout(ctx, tenant, payment.CheckoutRequest{
		Reference: PaymentReference(id), Amount: payment.MinorUnits(total, currency), Currency: currency,
		Description: fmt.Sprintf("%s × %d", eventName, b.Seats), CustomerEmail: b.Email,
		SuccessURL: s.siteURL + "/booking/paid", CancelURL: s.siteURL + "/booking/cancel?token=" + b.CancelToken,
		ExpiresAt: *b.HoldExpiresAt,
	})
	if err != nil {
		return "", err
	}
	return co.URL, nil
}

// bookingFromReference reads a provider reference back into a booking id.
func bookingFromReference(ref string) (uuid.UUID, bool) {
	raw, ok := strings.CutPrefix(ref, "event_booking:")
	if !ok {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(raw)
	return id, err == nil
}

// ConfirmPayment confirms a paid pending booking: invoice paid, paid_at,
// confirmation email. Idempotent for an already-paid booking (webhooks are
// retried); ErrState when the hold had already been released — the money
// came in for seats no longer held, and is refunded by hand.
func (s *Service) ConfirmPayment(ctx context.Context, tenant uuid.UUID, ref string) error {
	id, ok := bookingFromReference(ref)
	if !ok {
		return ErrNotFound
	}
	var b EventBooking
	err := orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		err := tx.QueryRow(ctx, `SELECT id, event_id, session_id, slot_end, starts_at, seats, email, name, user_id, cancel_token, status, invoice_id, paid_at
			FROM event_booking WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, id, tenant).
			Scan(&b.ID, &b.EventID, &b.SessionID, &b.SlotEnd, &b.StartsAt, &b.Seats, &b.Email, &b.Name, &b.UserID, &b.CancelToken, &b.Status, &b.InvoiceID, &b.PaidAt)
		if isNoRows(err) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if b.PaidAt != nil {
			return nil // a retried webhook
		}
		if b.Status != BookingPendingPayment {
			return fmt.Errorf("%w: payment received for a %s booking", ErrState, b.Status)
		}
		if _, err := tx.Exec(ctx, `UPDATE event_booking SET status = $2, paid_at = now(), hold_expires_at = NULL, updated_at = now() WHERE id = $1`,
			b.ID, BookingConfirmed); err != nil {
			return err
		}
		if b.InvoiceID != nil {
			if _, err := sale.SetInvoiceStatus(ctx, tx, tenant, *b.InvoiceID, "paid"); err != nil {
				return err
			}
		}
		ev, err := orm.MustRepo[Event](tx).FindOne(ctx, orm.Cond("id = $1 AND tenant_id = $2", b.EventID, tenant))
		if err != nil {
			return err
		}
		msg, err := confirmationEmail(ctx, tx, ev, b, *b.StartsAt, s.siteURL, "")
		if err != nil {
			return err
		}
		return eerpmail.Enqueue(ctx, tx, msg)
	})
	if errors.Is(err, ErrState) {
		common.Logger.Warn("event: payment for a released booking — refund it by hand", zap.String("booking", id.String()))
	}
	if err == nil && b.PaidAt == nil {
		s.log(ctx, tenant, b.EventID, b.Email, fmt.Sprintf("Paid online: %s, %d seat(s)", b.Name, b.Seats))
	}
	return err
}

// releaseHold cancels an unpaid pending booking silently (no email: the
// visitor simply didn't pay), freeing its seats for the waiting list and
// cancelling its invoice. Anything but a pending booking is left alone.
func (s *Service) releaseHold(ctx context.Context, tx *orm.Tx, tenant, id uuid.UUID) error {
	var sessionID, invoiceID *uuid.UUID
	var seats int
	err := tx.QueryRow(ctx, `UPDATE event_booking SET status = $3, cancelled_at = now(), hold_expires_at = NULL, updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND status = $4 RETURNING session_id, invoice_id, seats`,
		id, tenant, BookingCancelled, BookingPendingPayment).Scan(&sessionID, &invoiceID, &seats)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := releaseInvoice(ctx, tx, tenant, invoiceID); err != nil {
		return err
	}
	if sessionID == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE event_session SET seats_taken = seats_taken - $2, updated_at = now() WHERE id = $1`, *sessionID, seats); err != nil {
		return err
	}
	return s.offerNext(ctx, tx, tenant, *sessionID)
}

// ExpireHolds releases every pending payment past its deadline (event sweep).
func (s *Service) ExpireHolds(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT tenant_id, id FROM event_booking
		WHERE status = $1 AND hold_expires_at <= now() AND deleted_at IS NULL LIMIT 500`, BookingPendingPayment)
	if err != nil {
		return err
	}
	type due struct{ tenant, id uuid.UUID }
	var list []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.tenant, &d.id); err != nil {
			rows.Close()
			return err
		}
		list = append(list, d)
	}
	rows.Close()
	for _, d := range list {
		if err := orm.Transact(ctx, s.db, func(tx *orm.Tx) error { return s.releaseHold(ctx, tx, d.tenant, d.id) }); err != nil {
			return err
		}
	}
	return rows.Err()
}

// PaymentWebhook handles POST /api/v1/public/payments/:provider/webhook — a
// provider's signed notification for the site tenant: a paid checkout
// confirms its booking, an expired one releases the hold. 400 on a bad
// signature; 200 otherwise, so the provider stops retrying.
func (h *Handler) PaymentWebhook(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	prov, ok := payment.Lookup(c.Param("provider"))
	if !ok {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	body, err := io.ReadAll(io.LimitReader(c.Request().Body, 1<<20))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "unreadable body")
	}
	ev, err := prov.ParseWebhook(ctx, tenant, body, c.Request().Header)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid webhook")
	}
	id, ours := bookingFromReference(ev.Reference)
	switch {
	case !ours:
	case ev.Paid:
		if err := h.svc.ConfirmPayment(ctx, tenant, ev.Reference); err != nil && !errors.Is(err, ErrState) && !errors.Is(err, ErrNotFound) {
			return err // 5xx: the provider retries
		}
	case ev.Expired:
		if err := orm.Transact(ctx, h.db, func(tx *orm.Tx) error { return h.svc.releaseHold(ctx, tx, tenant, id) }); err != nil {
			return err
		}
	}
	return c.NoContent(http.StatusOK)
}
