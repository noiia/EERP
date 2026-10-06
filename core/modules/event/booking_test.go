package event

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"core/internal/auth"
	"core/internal/chatter"
	"core/internal/testdb"
	_ "core/modules/auth"
	_ "core/modules/chatter"
	_ "core/modules/company"
	"core/modules/contact"
	_ "core/modules/mail"
	_ "core/modules/sale"
	_ "core/modules/settings"
	_ "core/modules/warehouse"
	"core/orm"

	"github.com/google/uuid"
)

type fixture struct {
	svc    *Service
	db     *orm.DB
	tenant uuid.UUID
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "chatter", "contact", "mail", "settings", "company", "warehouse", "sale", "event")
	tenant := uuid.New()
	t.Cleanup(func() {
		ctx := context.Background()
		for _, table := range []string{"sale_line", "invoice", "product_variant", "product", "company", "event_booking", "event_session", "event_availability", "event", "contact", "mail_outbox", "mail_template", "app_settings", "chatter_message", "user_roles", "users"} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = $1`, tenant)
		}
	})
	return fixture{svc: NewService(app.DB, chatter.NewRepository(app.DB), "https://site.test"), db: app.DB, tenant: tenant}
}

func (f fixture) event(t *testing.T, e Event) Event {
	t.Helper()
	pub := true
	e.TenantID, e.Published = f.tenant, &pub
	if e.Timezone == "" {
		e.Timezone = "Europe/Paris"
	}
	if e.MaxSeatsPerBooking == 0 {
		e.MaxSeatsPerBooking = 10
	}
	out, err := orm.MustRepo[Event](f.db).Create(context.Background(), e)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (f fixture) session(t *testing.T, ev Event, capacity int, start time.Time) EventSession {
	t.Helper()
	s, err := orm.MustRepo[EventSession](f.db).Create(context.Background(),
		EventSession{TenantID: f.tenant, EventID: ev.ID, StartsAt: start, EndsAt: start.Add(time.Hour), Capacity: capacity})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func seatsTaken(t *testing.T, f fixture, id uuid.UUID) int {
	var n int
	_ = f.db.QueryRow(context.Background(), `SELECT seats_taken FROM event_session WHERE id = $1`, id).Scan(&n)
	return n
}

// Review Focus #1.
func TestBook_ConcurrentLastSeats(t *testing.T) {
	f := newFixture(t)
	ev := f.event(t, Event{Name: "Workshop", Kind: KindSessions})
	s := f.session(t, ev, 5, time.Now().Add(48*time.Hour))
	var ok, full atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := f.svc.Book(context.Background(), f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "v@x.io", Name: "V"})
			switch {
			case err == nil:
				ok.Add(1)
			case errors.Is(err, ErrFull):
				full.Add(1)
			default:
				t.Errorf("unexpected: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if ok.Load() != 5 || full.Load() != 15 || seatsTaken(t, f, s.ID) != 5 {
		t.Fatalf("ok=%d full=%d taken=%d", ok.Load(), full.Load(), seatsTaken(t, f, s.ID))
	}
}

func TestBook_SessionRules(t *testing.T) {
	f := newFixture(t)
	ev := f.event(t, Event{Name: "W", Kind: KindSessions, MaxSeatsPerBooking: 3})
	future := f.session(t, ev, 10, time.Now().Add(48*time.Hour))
	past := f.session(t, ev, 10, time.Now().Add(-time.Hour))
	other := f.event(t, Event{Name: "Other", Kind: KindSessions})
	unpublished := f.event(t, Event{Name: "Draft", Kind: KindSessions})
	_, _ = f.db.Exec(context.Background(), `UPDATE event SET published = false WHERE id = $1`, unpublished.ID)
	draftSession := f.session(t, unpublished, 10, time.Now().Add(48*time.Hour))
	// A session row of another tenant pointing at this tenant's event (the
	// generic layer doesn't check a relation target's tenant).
	foreignTenant := uuid.New()
	foreign, err := orm.MustRepo[EventSession](f.db).Create(context.Background(),
		EventSession{TenantID: foreignTenant, EventID: ev.ID, StartsAt: time.Now().Add(48 * time.Hour), EndsAt: time.Now().Add(49 * time.Hour), Capacity: 10})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = f.db.Exec(context.Background(), `DELETE FROM event_session WHERE tenant_id = $1`, foreignTenant)
	})
	appt := f.event(t, Event{Name: "Appt", Kind: KindAppointment, SlotMinutes: 30, SlotCapacity: 1})
	apptSession := f.session(t, appt, 10, time.Now().Add(48*time.Hour))

	tests := []struct {
		name string
		req  BookRequest
		want error
	}{
		{"ok", BookRequest{EventID: ev.ID, SessionID: &future.ID, Seats: 2, Email: "a@x.io", Name: "A"}, nil},
		{"too many seats", BookRequest{EventID: ev.ID, SessionID: &future.ID, Seats: 4, Email: "a@x.io", Name: "A"}, ErrBadRequest},
		{"zero seats", BookRequest{EventID: ev.ID, SessionID: &future.ID, Seats: 0, Email: "a@x.io", Name: "A"}, ErrBadRequest},
		{"bad email", BookRequest{EventID: ev.ID, SessionID: &future.ID, Seats: 1, Email: "nope", Name: "A"}, ErrBadRequest},
		{"past session", BookRequest{EventID: ev.ID, SessionID: &past.ID, Seats: 1, Email: "a@x.io", Name: "A"}, ErrFull},
		{"session of another event", BookRequest{EventID: other.ID, SessionID: &future.ID, Seats: 1, Email: "a@x.io", Name: "A"}, ErrNotBookable},
		{"unpublished event", BookRequest{EventID: unpublished.ID, SessionID: &draftSession.ID, Seats: 1, Email: "a@x.io", Name: "A"}, ErrNotBookable},
		{"session row of another tenant", BookRequest{EventID: ev.ID, SessionID: &foreign.ID, Seats: 1, Email: "a@x.io", Name: "A"}, ErrNotBookable},
		{"session of an appointment event", BookRequest{EventID: appt.ID, SessionID: &apptSession.ID, Seats: 1, Email: "a@x.io", Name: "A"}, ErrNotBookable},
		{"staff books an unpublished event", BookRequest{EventID: unpublished.ID, SessionID: &draftSession.ID, Seats: 1, Email: "s@x.io", Name: "S", Staff: true}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := f.svc.Book(context.Background(), f.tenant, tt.req)
			if !errors.Is(err, tt.want) { // errors.Is(nil, nil) is true
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
		})
	}

	t.Run("an anonymous booking creates no contact and queues exactly one email", func(t *testing.T) {
		var contacts, mails int
		_ = f.db.QueryRow(context.Background(), `SELECT count(*) FROM contact WHERE tenant_id = $1 AND lower(email) = 'a@x.io'`, f.tenant).Scan(&contacts)
		_ = f.db.QueryRow(context.Background(), `SELECT count(*) FROM mail_outbox WHERE tenant_id = $1 AND to_address = 'a@x.io'`, f.tenant).Scan(&mails)
		if contacts != 0 || mails != 1 {
			t.Errorf("contacts=%d mails=%d, want 0 and 1", contacts, mails)
		}
	})

	t.Run("signup creates a website contact; the account's bookings link to it", func(t *testing.T) {
		ctx := context.Background()
		users := auth.NewUserRepository(f.db)
		users.OnWebsiteSignup = func(ctx context.Context, tx *orm.Tx, u auth.Users) error {
			_, err := contact.CreateWebsiteContact(ctx, tx, u.TenantID, u.Name, u.Email)
			return err
		}
		u, err := users.CreateWebsiteUser(ctx, f.tenant, "member@x.io", "pw-123456789", "Member", "")
		if err != nil {
			t.Fatal(err)
		}
		var cid uuid.UUID
		var website *bool
		if err := f.db.QueryRow(ctx, `SELECT id, website FROM contact WHERE tenant_id = $1 AND email = 'member@x.io'`, f.tenant).Scan(&cid, &website); err != nil || website == nil || !*website {
			t.Fatalf("website contact: err=%v website=%v", err, website)
		}
		b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &future.ID, Seats: 1, Email: "other@x.io", Name: "M", UserID: &u.ID})
		if err != nil {
			t.Fatal(err)
		}
		if b.ContactID == nil || *b.ContactID != cid {
			t.Errorf("contact_id = %v, want the account's website contact %v", b.ContactID, cid)
		}
	})
}

// Review Focus #3 + slot capacity.
func TestBook_Slots(t *testing.T) {
	f := newFixture(t)
	ev := f.event(t, Event{Name: "Visit", Kind: KindAppointment, SlotMinutes: 30, SlotCapacity: 2, BookingHorizonDays: 60, MinNoticeHours: 2})
	paris, _ := time.LoadLocation("Europe/Paris")
	// Availability every day 09:00-12:00 so "next valid slot" always exists.
	for wd := 0; wd < 7; wd++ {
		if _, err := orm.MustRepo[EventAvailability](f.db).Create(context.Background(),
			EventAvailability{TenantID: f.tenant, EventID: ev.ID, Weekday: wd, FromTime: "09:00", ToTime: "12:00"}); err != nil {
			t.Fatal(err)
		}
	}
	d := time.Now().In(paris).AddDate(0, 0, 3)
	valid := time.Date(d.Year(), d.Month(), d.Day(), 9, 30, 0, 0, paris)
	offGrid := valid.Add(10 * time.Minute)
	farAway := valid.AddDate(0, 0, 90)

	for _, bad := range []time.Time{offGrid, farAway, time.Now().Add(30 * time.Minute)} {
		if _, err := f.svc.Book(context.Background(), f.tenant, BookRequest{EventID: ev.ID, SlotStart: &bad, Seats: 1, Email: "a@x.io", Name: "A"}); !errors.Is(err, ErrNotBookable) {
			t.Errorf("slot %v: err = %v, want ErrNotBookable", bad, err)
		}
	}

	var ok atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.svc.Book(context.Background(), f.tenant, BookRequest{EventID: ev.ID, SlotStart: &valid, Seats: 1, Email: "a@x.io", Name: "A"}); err == nil {
				ok.Add(1)
			}
		}()
	}
	wg.Wait()
	if ok.Load() != 2 {
		t.Fatalf("booked %d times, want slot_capacity 2", ok.Load())
	}
	slots, err := f.svc.Slots(context.Background(), f.tenant, ev.ID, valid.Add(-time.Hour), valid.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range slots {
		if s.Start.Equal(valid) {
			t.Error("full slot still listed")
		}
	}
}

// Review Focus #4.
func TestCancel(t *testing.T) {
	f := newFixture(t)
	ev := f.event(t, Event{Name: "W", Kind: KindSessions})
	s := f.session(t, ev, 3, time.Now().Add(48*time.Hour))
	b, err := f.svc.Book(context.Background(), f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 2, Email: "a@x.io", Name: "A"})
	if err != nil {
		t.Fatal(err)
	}
	var token string
	_ = f.db.QueryRow(context.Background(), `SELECT cancel_token FROM event_booking WHERE id = $1`, b.ID).Scan(&token)
	if len(token) != 64 {
		t.Fatalf("token %q, want 64 hex chars", token)
	}
	if err := f.svc.CancelByToken(context.Background(), f.tenant, token); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.CancelByToken(context.Background(), f.tenant, token); err != nil {
		t.Fatalf("second cancel: %v, want idempotent nil", err)
	}
	if seatsTaken(t, f, s.ID) != 0 {
		t.Errorf("seats_taken = %d, want 0 (freed exactly once)", seatsTaken(t, f, s.ID))
	}
	if err := f.svc.CancelByToken(context.Background(), f.tenant, "deadbeef"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown token: %v, want ErrNotFound", err)
	}
	other := uuid.New()
	if err := f.svc.CancelByID(context.Background(), f.tenant, b.ID, &other); !errors.Is(err, ErrNotFound) {
		t.Errorf("cancel by a non-owner: %v, want ErrNotFound", err)
	}
}
