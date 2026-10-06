package event

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"core/internal/payment"

	"github.com/google/uuid"
)

// fakeProvider is "connected" only while a test sets on.
type fakeProvider struct {
	on   bool
	fail bool
	last payment.CheckoutRequest
}

func (f *fakeProvider) Configured(context.Context, uuid.UUID) (bool, error) { return f.on, nil }
func (f *fakeProvider) CreateCheckout(_ context.Context, _ uuid.UUID, req payment.CheckoutRequest) (payment.Checkout, error) {
	f.last = req
	if f.fail {
		return payment.Checkout{}, errors.New("provider down")
	}
	return payment.Checkout{ID: "cs_1", URL: "https://pay.test/cs_1"}, nil
}
func (f *fakeProvider) ParseWebhook(context.Context, uuid.UUID, []byte, http.Header) (payment.WebhookEvent, error) {
	return payment.WebhookEvent{}, nil
}

var fake = &fakeProvider{}

func init() { payment.Register("fake_pay", fake) }

// connect turns the fake provider on and gives the tenant a company with a
// currency (a checkout needs one).
func connect(t *testing.T, f fixture) *fakeProvider {
	t.Helper()
	if _, err := f.db.Exec(context.Background(), `INSERT INTO company (tenant_id, name, currency) VALUES ($1, 'Co', 'EUR')`, f.tenant); err != nil {
		t.Fatal(err)
	}
	fake.on, fake.fail = true, false
	t.Cleanup(func() { fake.on = false })
	return fake
}

func TestPayment_OnlineFlow(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	prov := connect(t, f)
	v := f.variant(t, 12.5, 0.2)
	ev := f.event(t, Event{Name: "Pottery", Kind: KindSessions, ProductVariantID: &v})
	s := f.session(t, ev, 2, time.Now().Add(48*time.Hour))

	b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 2, Email: "card@x.io", Name: "C"})
	if err != nil || b.Status != BookingPendingPayment {
		t.Fatalf("book = %+v %v, want pending_payment", b, err)
	}
	if seatsTaken(t, f, s.ID) != 2 {
		t.Errorf("a pending payment must hold its seats: %d", seatsTaken(t, f, s.ID))
	}
	if got := outboxSubjects(t, f, "card@x.io"); len(got) != 0 {
		t.Errorf("emails before payment = %q, want none", got)
	}
	url, err := f.svc.Checkout(ctx, f.tenant, b.ID)
	if err != nil || url != "https://pay.test/cs_1" {
		t.Fatalf("checkout = %q %v", url, err)
	}
	if prov.last.Amount != 3000 || prov.last.Reference != PaymentReference(b.ID) || !strings.Contains(prov.last.CancelURL, "/booking/cancel?token=") {
		t.Errorf("checkout request = %+v, want 30.00 (2 × 12.50 + 20%%) for this booking", prov.last)
	}

	if err := f.svc.ConfirmPayment(ctx, f.tenant, PaymentReference(b.ID)); err != nil {
		t.Fatal(err)
	}
	if st, _ := bookingStatus(t, f, b.ID); st != BookingConfirmed {
		t.Errorf("after payment status = %q", st)
	}
	if _, _, status := invoiceOf(t, f, b.ID); status != "paid" {
		t.Errorf("invoice after payment = %q, want paid", status)
	}
	if got := outboxSubjects(t, f, "card@x.io"); len(got) != 1 || !strings.HasPrefix(got[0], "Booking confirmed") {
		t.Errorf("emails after payment = %q, want one confirmation", got)
	}
	if err := f.svc.ConfirmPayment(ctx, f.tenant, PaymentReference(b.ID)); err != nil {
		t.Errorf("a repeated webhook must be harmless: %v", err)
	}

	// Staff bookings are never sent to online payment: confirmed, to pay at the event.
	s2 := f.session(t, ev, 2, time.Now().Add(72*time.Hour))
	sb, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s2.ID, Seats: 1, Email: "staff@x.io", Name: "S", Staff: true})
	if err != nil || sb.Status != BookingConfirmed {
		t.Fatalf("staff booking = %+v %v, want confirmed", sb, err)
	}
}

func TestPayment_HoldExpiresAndFailedCheckoutReleases(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	prov := connect(t, f)
	v := f.variant(t, 10, 0)
	ev := f.event(t, Event{Name: "Pottery", Kind: KindSessions, ProductVariantID: &v})
	s := f.session(t, ev, 1, time.Now().Add(48*time.Hour))

	b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "slow@x.io", Name: "S"})
	if err != nil || b.Status != BookingPendingPayment {
		t.Fatalf("book = %+v %v", b, err)
	}
	if _, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "late@x.io", Name: "L"}); !errors.Is(err, ErrFull) {
		t.Errorf("the pending payment's seat was booked again: %v", err)
	}
	if _, err := f.db.Exec(ctx, `UPDATE event_booking SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.ExpireHolds(ctx); err != nil {
		t.Fatal(err)
	}
	if st, _ := bookingStatus(t, f, b.ID); st != BookingCancelled {
		t.Errorf("expired hold status = %q, want cancelled", st)
	}
	if _, _, status := invoiceOf(t, f, b.ID); status != "cancelled" {
		t.Errorf("expired hold invoice = %q, want cancelled", status)
	}
	if err := f.svc.ConfirmPayment(ctx, f.tenant, PaymentReference(b.ID)); !errors.Is(err, ErrState) {
		t.Errorf("payment after the hold expired: %v, want ErrState (refund by hand)", err)
	}

	// The provider fails: the hold is released at once.
	s2 := f.session(t, ev, 1, time.Now().Add(72*time.Hour))
	b2, _ := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s2.ID, Seats: 1, Email: "x@x.io", Name: "X"})
	prov.fail = true
	if _, err := f.svc.Checkout(ctx, f.tenant, b2.ID); !errors.Is(err, ErrPaymentUnavailable) {
		t.Fatalf("checkout with the provider down: %v", err)
	}
	if seatsTaken(t, f, s2.ID) != 0 {
		t.Errorf("seats after a failed checkout = %d, want released", seatsTaken(t, f, s2.ID))
	}

	// Not connected: the booking is confirmed at once, to pay at the event.
	prov.on = false
	s3 := f.session(t, ev, 1, time.Now().Add(96*time.Hour))
	b3, _ := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s3.ID, Seats: 1, Email: "later@x.io", Name: "L"})
	if b3.Status != BookingConfirmed {
		t.Errorf("unconnected booking status = %q, want confirmed", b3.Status)
	}
}
