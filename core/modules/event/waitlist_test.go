package event

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func bookingStatus(t *testing.T, f fixture, id uuid.UUID) (status, offerToken string) {
	t.Helper()
	if err := f.db.QueryRow(context.Background(), `SELECT status, offer_token FROM event_booking WHERE id = $1`, id).Scan(&status, &offerToken); err != nil {
		t.Fatal(err)
	}
	return status, offerToken
}

func TestWaitlist(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	ev := f.event(t, Event{Name: "Yoga", Kind: KindSessions})
	s := f.session(t, ev, 1, time.Now().Add(48*time.Hour))
	req := func(email string, waitlist bool) BookRequest {
		return BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: email, Name: "N", Waitlist: waitlist}
	}
	a, err := f.svc.Book(ctx, f.tenant, req("a@x.io", false))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Book(ctx, f.tenant, req("b@x.io", false)); !errors.Is(err, ErrFull) {
		t.Fatalf("full session without waitlist: %v, want ErrFull", err)
	}
	b, err := f.svc.Book(ctx, f.tenant, req("b@x.io", true))
	if err != nil || b.Status != BookingWaitlisted {
		t.Fatalf("join waitlist: %+v %v", b, err)
	}
	c, _ := f.svc.Book(ctx, f.tenant, req("c@x.io", true))
	if seatsTaken(t, f, s.ID) != 1 {
		t.Fatalf("waitlisted bookings took seats: %d", seatsTaken(t, f, s.ID))
	}
	if got := outboxSubjects(t, f, "b@x.io"); len(got) != 1 || !strings.Contains(got[0], "waiting list") {
		t.Errorf("waitlist email = %q", got)
	}
	if err := f.svc.SetAttendance(ctx, f.tenant, b.ID, BookingAttended); !errors.Is(err, ErrState) {
		t.Errorf("check-in a waitlisted booking: %v, want ErrState", err)
	}

	// A frees the seat: the first in line (B) gets an offer, C waits.
	if err := f.svc.CancelByID(ctx, f.tenant, a.ID, nil); err != nil {
		t.Fatal(err)
	}
	_, tokB := bookingStatus(t, f, b.ID)
	if _, tokC := bookingStatus(t, f, c.ID); tokB == "" || tokC != "" {
		t.Fatalf("offers after cancel: B %q, C %q — want only B", tokB, tokC)
	}
	if got := outboxSubjects(t, f, "b@x.io"); len(got) != 2 || !strings.Contains(strings.ToLower(got[1]), "seat is free") {
		t.Errorf("offer email = %q", got)
	}

	// B lets the offer expire: C is next.
	if _, err := f.db.Exec(ctx, `UPDATE event_booking SET offer_expires_at = now() - interval '1 minute' WHERE id = $1`, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.ExpireOffers(ctx); err != nil {
		t.Fatal(err)
	}
	if st, _ := bookingStatus(t, f, b.ID); st != BookingExpired {
		t.Errorf("B after expiry = %q, want expired", st)
	}
	if err := f.svc.ClaimOffer(ctx, f.tenant, tokB); !errors.Is(err, ErrNotFound) {
		t.Errorf("claim an expired offer: %v, want ErrNotFound", err)
	}
	_, tokC := bookingStatus(t, f, c.ID)
	if tokC == "" {
		t.Fatal("C got no offer after B's expired")
	}
	if err := f.svc.ClaimOffer(ctx, f.tenant, tokC); err != nil {
		t.Fatalf("C claims: %v", err)
	}
	if st, tok := bookingStatus(t, f, c.ID); st != BookingConfirmed || tok != "" {
		t.Errorf("C after claim = %q (token %q), want confirmed and the token spent", st, tok)
	}
	if seatsTaken(t, f, s.ID) != 1 {
		t.Errorf("seats after claim = %d, want 1", seatsTaken(t, f, s.ID))
	}
	if err := f.svc.ClaimOffer(ctx, f.tenant, tokC); !errors.Is(err, ErrNotFound) {
		t.Errorf("second claim: %v, want ErrNotFound", err)
	}
}

// An offer doesn't reserve the seat: a faster booking wins, and the claim is a 409.
func TestWaitlist_ClaimLosesToAFasterBooking(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	ev := f.event(t, Event{Name: "Yoga", Kind: KindSessions})
	s := f.session(t, ev, 1, time.Now().Add(48*time.Hour))
	a, _ := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "a@x.io", Name: "A"})
	w, _ := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "w@x.io", Name: "W", Waitlist: true})
	if err := f.svc.CancelByID(ctx, f.tenant, a.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "fast@x.io", Name: "F"}); err != nil {
		t.Fatal(err)
	}
	_, tok := bookingStatus(t, f, w.ID)
	if err := f.svc.ClaimOffer(ctx, f.tenant, tok); !errors.Is(err, ErrFull) {
		t.Fatalf("claim after the seat went: %v, want ErrFull", err)
	}
	if st, _ := bookingStatus(t, f, w.ID); st != BookingWaitlisted {
		t.Errorf("W after a lost claim = %q, want still waitlisted", st)
	}
	// A waitlisted booking is cancelled without touching seats.
	if err := f.svc.CancelByID(ctx, f.tenant, w.ID, nil); err != nil {
		t.Fatal(err)
	}
	if seatsTaken(t, f, s.ID) != 1 {
		t.Errorf("seats after cancelling a waitlisted booking = %d, want 1", seatsTaken(t, f, s.ID))
	}
}
