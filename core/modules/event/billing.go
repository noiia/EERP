package event

import (
	"context"
	"fmt"
	"strings"

	eerpmail "core/internal/mail"
	"core/modules/sale"
	"core/orm"

	"github.com/google/uuid"
)

// Paid events: an event with a sale product variant invoices each confirmed
// booking (one line: the variant × seats, a session's price overriding the
// unit price) in the booking's own transaction. Without online payment the
// invoice stays "sent" and the booker pays at the event: the confirmation
// says how much, and staff mark it paid from the booking (MarkPaid).

const TemplateConfirmedPayLater = "event.booking_confirmed_pay_later"

func init() {
	eerpmail.RegisterTemplate(eerpmail.TemplateDef{
		Key: TemplateConfirmedPayLater, Label: "Event booking confirmed, to pay at the event",
		Vars: append(append([]string{}, bookingVars...), "amount"),
		Defaults: map[string]eerpmail.Content{
			"en": {Subject: "Booking confirmed: {{event}}", HTML: `<p>Hello {{name}},</p><p>Your booking is confirmed.</p>` +
				`<ul><li>Event: {{event}}</li><li>When: {{when}}</li><li>Seats: {{seats}}</li><li>Where: {{location}}</li></ul>` +
				`<p><strong>Amount due at the event: {{amount}}</strong></p><p><a href="{{cancel_url}}">Cancel this booking</a></p>`},
			"fr": {Subject: "Réservation confirmée : {{event}}", HTML: `<p>Bonjour {{name}},</p><p>Votre réservation est confirmée.</p>` +
				`<ul><li>Événement : {{event}}</li><li>Quand : {{when}}</li><li>Places : {{seats}}</li><li>Où : {{location}}</li></ul>` +
				`<p><strong>Montant à régler sur place : {{amount}}</strong></p><p><a href="{{cancel_url}}">Annuler cette réservation</a></p>`},
		},
	})
}

// charge invoices b when its event is priced, storing the invoice on the
// booking; returns the amount due ("" for a free booking).
func (s *Service) charge(ctx context.Context, tx *orm.Tx, ev Event, b *EventBooking) (string, error) {
	if ev.ProductVariantID == nil {
		return "", nil
	}
	var override *float64
	if b.SessionID != nil {
		if err := tx.QueryRow(ctx, `SELECT price FROM event_session WHERE id = $1`, *b.SessionID).Scan(&override); err != nil {
			return "", err
		}
	}
	price := 0.0
	if override != nil {
		price = *override
	} else {
		p, err := sale.VariantPrice(ctx, tx, ev.TenantID, *ev.ProductVariantID)
		if err != nil {
			return "", fmt.Errorf("event %s: %w", ev.Name, err)
		}
		price = p
	}
	if price <= 0 {
		return "", nil
	}
	inv, err := sale.CreateInvoice(ctx, tx, sale.InvoiceRequest{
		TenantID: ev.TenantID, CustomerID: b.ContactID, CustomerName: b.Name, CustomerEmail: b.Email,
		Number: "EVT-" + strings.ToUpper(b.ID.String()[:8]), Subject: ev.Name,
		VariantID: *ev.ProductVariantID, Quantity: float64(b.Seats), UnitPrice: override,
	})
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE event_booking SET invoice_id = $2, updated_at = now() WHERE id = $1`, b.ID, inv.ID); err != nil {
		return "", err
	}
	b.InvoiceID = &inv.ID
	currency, err := sale.WorkspaceCurrency(ctx, tx, ev.TenantID)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(fmt.Sprintf("%.2f %s", *inv.Total, currency)), nil
}

// releaseInvoice cancels a cancelled booking's invoice — never a paid one.
func releaseInvoice(ctx context.Context, tx *orm.Tx, tenant uuid.UUID, invoiceID *uuid.UUID) error {
	if invoiceID == nil {
		return nil
	}
	_, err := sale.SetInvoiceStatus(ctx, tx, tenant, *invoiceID, "cancelled", "paid")
	return err
}

// MarkPaid records that a booking's invoice was paid (at the event, say).
// ErrState when the booking has no invoice.
func (s *Service) MarkPaid(ctx context.Context, tenant, id uuid.UUID) error {
	var invoiceID *uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT invoice_id FROM event_booking WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
		id, tenant).Scan(&invoiceID)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if invoiceID == nil {
		return ErrState
	}
	return orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		if _, err := sale.SetInvoiceStatus(ctx, tx, tenant, *invoiceID, "paid", "cancelled"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE event_booking SET paid_at = COALESCE(paid_at, now()), updated_at = now() WHERE id = $1`, id)
		return err
	})
}
