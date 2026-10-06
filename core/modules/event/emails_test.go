package event

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	eerpmail "core/internal/mail"
	"core/internal/settings"

	"github.com/google/uuid"
)

// Staff-typed event names must neither break headers nor inject markup.
func TestConfirmationEmail_EscapesEventName(t *testing.T) {
	f := newFixture(t)
	loc := "Room <1>"
	ev := Event{Name: "Evil\r\nBcc: x@y.io <script>", Location: &loc, Timezone: "Europe/Paris"}
	ev.TenantID = f.tenant
	msg, err := confirmationEmail(context.Background(), f.db, ev, EventBooking{Email: "a@x.io", Name: "A", Seats: 1, CancelToken: "tok"}, time.Now(), "https://site.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(msg.Subject, "\r\n") {
		t.Errorf("subject %q contains a line break", msg.Subject)
	}
	if strings.Contains(msg.HTML, "<script>") || strings.Contains(msg.HTML, "<1>") {
		t.Errorf("HTML not escaped: %s", msg.HTML)
	}
	if !strings.Contains(msg.Text, "https://site.test/booking/cancel?token=tok") {
		t.Errorf("text lacks cancel link: %s", msg.Text)
	}
}

func outboxSubjects(t *testing.T, f fixture, to string) []string {
	t.Helper()
	rows, err := f.db.Query(context.Background(), `SELECT subject FROM mail_outbox WHERE tenant_id = $1 AND to_address = $2 ORDER BY created_at`, f.tenant, to)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		out = append(out, s)
	}
	return out
}

func TestEmails_InTheAccountLanguage(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	var userID uuid.UUID
	if err := f.db.QueryRow(ctx, `INSERT INTO users (tenant_id, email, preferred_locale) VALUES ($1, $2, 'fr') RETURNING id`,
		f.tenant, "fr-"+uuid.NewString()[:8]+"@x.io").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	ev := f.event(t, Event{Name: "Yoga", Kind: KindSessions})
	s := f.session(t, ev, 5, time.Now().Add(48*time.Hour))
	b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "fr@x.io", Name: "Anne", UserID: &userID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "anon@x.io", Name: "Ann"}); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.CancelByID(ctx, f.tenant, b.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got := outboxSubjects(t, f, "fr@x.io"); len(got) != 2 || !strings.HasPrefix(got[0], "Réservation confirmée") || !strings.HasPrefix(got[1], "Réservation annulée") {
		t.Errorf("account emails = %q, want French confirmation then cancellation", got)
	}
	if got := outboxSubjects(t, f, "anon@x.io"); len(got) != 1 || !strings.HasPrefix(got[0], "Booking confirmed") {
		t.Errorf("anonymous email = %q, want the English (workspace default) confirmation", got)
	}
	// The workspace default applies to anonymous bookers.
	if err := settings.NewRepository(f.db).Set(ctx, f.tenant, uuid.New(), "i18n.default_locale", "fr"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "anon2@x.io", Name: "Bo"}); err != nil {
		t.Fatal(err)
	}
	if got := outboxSubjects(t, f, "anon2@x.io"); len(got) != 1 || !strings.HasPrefix(got[0], "Réservation confirmée") {
		t.Errorf("anonymous email with a French workspace = %q", got)
	}
}

func TestSendReminders(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	ev := f.event(t, Event{Name: "Yoga", Kind: KindSessions})
	book := func(email string, startsIn time.Duration, bookedAgo time.Duration) EventBooking {
		t.Helper()
		s := f.session(t, ev, 5, time.Now().Add(startsIn))
		b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: email, Name: "N"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Exec(ctx, `UPDATE event_booking SET created_at = now() - $2::interval WHERE id = $1`, b.ID, bookedAgo.String()); err != nil {
			t.Fatal(err)
		}
		return b
	}
	book("due@x.io", 10*time.Hour, 72*time.Hour)
	book("late@x.io", 10*time.Hour, time.Minute) // booked inside the window: the confirmation is enough
	book("far@x.io", 48*time.Hour, 72*time.Hour)
	cancelled := book("off@x.io", 10*time.Hour, 72*time.Hour)
	if err := f.svc.CancelByID(ctx, f.tenant, cancelled.ID, nil); err != nil {
		t.Fatal(err)
	}

	for range 2 { // a second sweep sends nothing new
		if _, err := f.svc.SendReminders(ctx); err != nil {
			t.Fatal(err)
		}
	}
	reminders := func(to string) int {
		n := 0
		for _, s := range outboxSubjects(t, f, to) {
			if strings.HasPrefix(s, "Reminder") {
				n++
			}
		}
		return n
	}
	for to, want := range map[string]int{"due@x.io": 1, "late@x.io": 0, "far@x.io": 0, "off@x.io": 0} {
		if got := reminders(to); got != want {
			t.Errorf("%s: %d reminders, want %d", to, got, want)
		}
	}

	// reminder_hours 0 turns reminders off for the tenant.
	if err := settings.NewRepository(f.db).Set(ctx, f.tenant, uuid.Nil, SettingsKey, `{"reminder_hours":0}`); err != nil {
		t.Fatal(err)
	}
	book("off2@x.io", 10*time.Hour, 72*time.Hour)
	if _, err := f.svc.SendReminders(ctx); err != nil {
		t.Fatal(err)
	}
	if got := reminders("off2@x.io"); got != 0 {
		t.Errorf("reminders with reminder_hours 0 = %d", got)
	}
	// 72 h: the far booking is now due.
	if err := settings.NewRepository(f.db).Set(ctx, f.tenant, uuid.Nil, SettingsKey, `{"reminder_hours":72}`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SendReminders(ctx); err != nil {
		t.Fatal(err)
	}
	if got := reminders("far@x.io"); got != 1 {
		t.Errorf("far booking with reminder_hours 72: %d reminders, want 1", got)
	}
}

func TestEmails_CarryTheCalendarInvite(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	ev := f.event(t, Event{Name: "Yoga", Kind: KindSessions})
	s := f.session(t, ev, 5, time.Now().Add(48*time.Hour))
	b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "ics@x.io", Name: "N"})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.CancelByID(ctx, f.tenant, b.ID, nil); err != nil {
		t.Fatal(err)
	}
	rows, err := f.db.Query(ctx, `SELECT attachments FROM mail_outbox WHERE tenant_id = $1 AND to_address = 'ics@x.io' ORDER BY created_at`, f.tenant)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var a string
		_ = rows.Scan(&a)
		got = append(got, a)
	}
	uid := "booking-" + b.ID.String()
	if len(got) != 2 {
		t.Fatalf("emails = %d, want 2", len(got))
	}
	for i, method := range []string{"PUBLISH", "CANCEL"} {
		var atts []eerpmail.Attachment
		if err := json.Unmarshal([]byte(got[i]), &atts); err != nil || len(atts) != 1 {
			t.Fatalf("email %d attachments = %q (%v)", i, got[i], err)
		}
		ics := string(atts[0].Data)
		if !strings.Contains(ics, "METHOD:"+method) || !strings.Contains(ics, "UID:"+uid+"@eerp") {
			t.Errorf("email %d invite:\n%s", i, ics)
		}
	}
}
