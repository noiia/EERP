package event

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// variant creates a product at price (excl. tax) with tax rate, and its variant.
func (f fixture) variant(t *testing.T, price, rate float64) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var product, variant uuid.UUID
	if err := f.db.QueryRow(ctx, `INSERT INTO product (tenant_id, name, description, reference, unit, unit_price, tax_rate)
		VALUES ($1, 'Ticket', '', 'T', 'unit', $2, $3) RETURNING id`, f.tenant, price, rate).Scan(&product); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(ctx, `INSERT INTO product_variant (tenant_id, product_id, name) VALUES ($1, $2, 'Ticket') RETURNING id`,
		f.tenant, product).Scan(&variant); err != nil {
		t.Fatal(err)
	}
	return variant
}

func invoiceOf(t *testing.T, f fixture, bookingID uuid.UUID) (id *uuid.UUID, total float64, status string) {
	t.Helper()
	ctx := context.Background()
	if err := f.db.QueryRow(ctx, `SELECT invoice_id FROM event_booking WHERE id = $1`, bookingID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if id != nil {
		if err := f.db.QueryRow(ctx, `SELECT total, status FROM invoice WHERE id = $1`, *id).Scan(&total, &status); err != nil {
			t.Fatal(err)
		}
	}
	return id, total, status
}

func TestBooking_Invoicing(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	v := f.variant(t, 20, 0.2)
	ev := f.event(t, Event{Name: "Pottery", Kind: KindSessions, ProductVariantID: &v})
	s := f.session(t, ev, 10, time.Now().Add(48*time.Hour))
	b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 2, Email: "pay@x.io", Name: "Payer"})
	if err != nil {
		t.Fatal(err)
	}
	id, total, status := invoiceOf(t, f, b.ID)
	if id == nil || math.Abs(total-48) > 1e-9 || status != "sent" {
		t.Fatalf("invoice = %v total %v status %q, want 2 × 20 + 20%% tax = 48, sent", id, total, status)
	}
	var html string
	_ = f.db.QueryRow(ctx, `SELECT body_html FROM mail_outbox WHERE to_address = 'pay@x.io'`).Scan(&html)
	if !strings.Contains(html, "48.00") {
		t.Errorf("confirmation lacks the amount due: %s", html)
	}

	// A session price overrides the variant's unit price.
	price := 10.0
	if _, err := f.db.Exec(ctx, `UPDATE event_session SET price = $2 WHERE id = $1`, s.ID, price); err != nil {
		t.Fatal(err)
	}
	b2, _ := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 2, Email: "p2@x.io", Name: "P2"})
	if _, total, _ := invoiceOf(t, f, b2.ID); math.Abs(total-24) > 1e-9 {
		t.Errorf("session-priced invoice total = %v, want 24", total)
	}

	// Marked paid, then cancelled: the paid invoice stays paid.
	if err := f.svc.MarkPaid(ctx, f.tenant, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.CancelByID(ctx, f.tenant, b.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, status := invoiceOf(t, f, b.ID); status != "paid" {
		t.Errorf("paid invoice after cancel = %q, want paid", status)
	}
	// Unpaid and cancelled: the invoice is cancelled too.
	if err := f.svc.CancelByID(ctx, f.tenant, b2.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, status := invoiceOf(t, f, b2.ID); status != "cancelled" {
		t.Errorf("unpaid invoice after cancel = %q, want cancelled", status)
	}

	free := f.event(t, Event{Name: "Free", Kind: KindSessions})
	fs := f.session(t, free, 10, time.Now().Add(48*time.Hour))
	fb, _ := f.svc.Book(ctx, f.tenant, BookRequest{EventID: free.ID, SessionID: &fs.ID, Seats: 1, Email: "free@x.io", Name: "F"})
	if id, _, _ := invoiceOf(t, f, fb.ID); id != nil {
		t.Errorf("a free event's booking got invoice %v", id)
	}
	if err := f.svc.MarkPaid(ctx, f.tenant, fb.ID); err != ErrState { //nolint:errorlint
		t.Errorf("mark paid without an invoice: %v, want ErrState", err)
	}
}
