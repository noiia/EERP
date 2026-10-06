package event

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func contactOf(t *testing.T, f fixture, bookingID uuid.UUID) (id *uuid.UUID, name, email string) {
	t.Helper()
	ctx := context.Background()
	if err := f.db.QueryRow(ctx, `SELECT contact_id FROM event_booking WHERE id = $1`, bookingID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if id != nil {
		if err := f.db.QueryRow(ctx, `SELECT name, email FROM contact WHERE id = $1`, *id).Scan(&name, &email); err != nil {
			t.Fatal(err)
		}
	}
	return id, name, email
}

// Every booking — anonymous, staff or account — is tied to a native contact,
// found by email or created.
func TestBooking_LinksANativeContact(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	ev := f.event(t, Event{Name: "Yoga", Kind: KindSessions})
	s := f.session(t, ev, 20, time.Now().Add(48*time.Hour))
	book := func(email, name string, staff bool) EventBooking {
		t.Helper()
		b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: email, Name: name, Staff: staff})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	anon := book("Ann@X.io", "Ann", false)
	id, name, email := contactOf(t, f, anon.ID)
	if id == nil || name != "Ann" || email != "ann@x.io" {
		t.Fatalf("anonymous booking contact = %v %q %q, want a new contact Ann <ann@x.io>", id, name, email)
	}
	if again, _, _ := contactOf(t, f, book("ann@x.io", "Ann B.", false).ID); again == nil || *again != *id {
		t.Errorf("same email booked again: contact %v, want the existing %v", again, *id)
	}
	if staff, _, _ := contactOf(t, f, book("bob@x.io", "Bob", true).ID); staff == nil {
		t.Error("a staff booking created no contact")
	}

	var erp uuid.UUID
	if err := f.db.QueryRow(ctx, `INSERT INTO contact (tenant_id, name, email, company, status) VALUES ($1, 'Carol (ERP)', 'carol@x.io', '', 'customer') RETURNING id`,
		f.tenant).Scan(&erp); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := contactOf(t, f, book("carol@x.io", "Carol", false).ID); got == nil || *got != erp {
		t.Errorf("booking with an ERP contact's email linked %v, want the existing %v", got, erp)
	}

	// Concurrent first bookings with one email create one contact.
	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "race@x.io", Name: "R"})
		}()
	}
	wg.Wait()
	var n int
	_ = f.db.QueryRow(ctx, `SELECT count(*) FROM contact WHERE tenant_id = $1 AND lower(email) = 'race@x.io'`, f.tenant).Scan(&n)
	if n != 1 {
		t.Errorf("concurrent bookings created %d contacts, want 1", n)
	}
}
