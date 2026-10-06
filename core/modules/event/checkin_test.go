package event

import (
	"context"
	"errors"
	"testing"
	"time"

	"core/orm"

	"github.com/google/uuid"
)

func bookingRow(t *testing.T, f fixture, id uuid.UUID) (status string, startsAt *time.Time) {
	t.Helper()
	if err := f.db.QueryRow(context.Background(), `SELECT status, starts_at FROM event_booking WHERE id = $1`, id).
		Scan(&status, &startsAt); err != nil {
		t.Fatal(err)
	}
	return status, startsAt
}

// moveStart pretends the booking's session started `ago` ago (booking a past
// session is refused, so tests book a future one then move its start).
func moveStart(t *testing.T, f fixture, id uuid.UUID, ago time.Duration) {
	t.Helper()
	if _, err := f.db.Exec(context.Background(), `UPDATE event_booking SET starts_at = $2 WHERE id = $1`, id, time.Now().Add(-ago)); err != nil {
		t.Fatal(err)
	}
}

func TestBook_StoresStartsAt(t *testing.T) {
	f := newFixture(t)
	ev := f.event(t, Event{Name: "W", Kind: KindSessions})
	s := f.session(t, ev, 5, time.Now().Add(48*time.Hour).Truncate(time.Second))
	b, err := f.svc.Book(context.Background(), f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "a@x.io", Name: "A"})
	if err != nil {
		t.Fatal(err)
	}
	if _, at := bookingRow(t, f, b.ID); at == nil || !at.Equal(s.StartsAt) {
		t.Fatalf("starts_at = %v, want the session start %v", at, s.StartsAt)
	}
}

func TestSetAttendance(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	ev := f.event(t, Event{Name: "W", Kind: KindSessions})
	s := f.session(t, ev, 5, time.Now().Add(48*time.Hour))
	b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 2, Email: "a@x.io", Name: "A"})
	if err != nil {
		t.Fatal(err)
	}

	if err := f.svc.SetAttendance(ctx, f.tenant, b.ID, BookingAttended); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("check-in two days early: %v, want ErrBadRequest", err)
	}
	moveStart(t, f, b.ID, -30*time.Minute) // starts in 30 min: check-in is open
	if err := f.svc.SetAttendance(ctx, f.tenant, b.ID, BookingAttended); err != nil {
		t.Fatalf("check-in 30 min before: %v", err)
	}
	if st, _ := bookingRow(t, f, b.ID); st != BookingAttended {
		t.Fatalf("status = %q, want attended", st)
	}
	if seatsTaken(t, f, s.ID) != 2 {
		t.Errorf("seats_taken = %d, want 2 (an attendee keeps the seat)", seatsTaken(t, f, s.ID))
	}
	if err := f.svc.SetAttendance(ctx, f.tenant, b.ID, BookingNoShow); err != nil {
		t.Fatalf("correcting attended → no_show: %v", err)
	}
	if err := f.svc.CancelByID(ctx, f.tenant, b.ID, nil); !errors.Is(err, ErrState) {
		t.Fatalf("cancel after check-in: %v, want ErrState", err)
	}
	if err := f.svc.SetAttendance(ctx, f.tenant, b.ID, BookingCancelled); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("attendance status cancelled: %v, want ErrBadRequest", err)
	}

	c, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "c@x.io", Name: "C"})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.CancelByID(ctx, f.tenant, c.ID, nil); err != nil {
		t.Fatal(err)
	}
	moveStart(t, f, c.ID, time.Hour)
	if err := f.svc.SetAttendance(ctx, f.tenant, c.ID, BookingAttended); !errors.Is(err, ErrState) {
		t.Fatalf("check-in a cancelled booking: %v, want ErrState", err)
	}
	if err := f.svc.SetAttendance(ctx, f.tenant, uuid.New(), BookingAttended); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown booking: %v, want ErrNotFound", err)
	}
}

// A no-show still holds its slot: capacity counts every booking but cancelled ones.
func TestSlotCapacity_CountsCheckedInBookings(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	ev := f.event(t, Event{Name: "Visit", Kind: KindAppointment, SlotMinutes: 30, SlotCapacity: 1, BookingHorizonDays: 60, MinNoticeHours: 2})
	for wd := 0; wd < 7; wd++ {
		if _, err := orm.MustRepo[EventAvailability](f.db).Create(ctx,
			EventAvailability{TenantID: f.tenant, EventID: ev.ID, Weekday: wd, FromTime: "09:00", ToTime: "12:00"}); err != nil {
			t.Fatal(err)
		}
	}
	paris, _ := time.LoadLocation("Europe/Paris")
	d := time.Now().In(paris).AddDate(0, 0, 3)
	slot := time.Date(d.Year(), d.Month(), d.Day(), 10, 0, 0, 0, paris)
	b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SlotStart: &slot, Seats: 1, Email: "a@x.io", Name: "A"})
	if err != nil {
		t.Fatal(err)
	}
	if _, at := bookingRow(t, f, b.ID); at == nil || !at.Equal(slot) {
		t.Fatalf("starts_at = %v, want the slot start %v", at, slot)
	}
	if _, err := f.db.Exec(ctx, `UPDATE event_booking SET status = $2 WHERE id = $1`, b.ID, BookingNoShow); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SlotStart: &slot, Seats: 1, Email: "b@x.io", Name: "B"}); !errors.Is(err, ErrFull) {
		t.Fatalf("booking a slot held by a no-show: %v, want ErrFull", err)
	}
	slots, err := f.svc.Slots(ctx, f.tenant, ev.ID, slot.Add(-time.Hour), slot.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range slots {
		if s.Start.Equal(slot) {
			t.Error("a slot held by a no-show is still listed")
		}
	}
}

func TestSyncSessionStart_AndMigrateBackfill(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	ev := f.event(t, Event{Name: "W", Kind: KindSessions})
	s := f.session(t, ev, 5, time.Now().Add(48*time.Hour))
	b, err := f.svc.Book(ctx, f.tenant, BookRequest{EventID: ev.ID, SessionID: &s.ID, Seats: 1, Email: "a@x.io", Name: "A"})
	if err != nil {
		t.Fatal(err)
	}
	moved := s.StartsAt.Add(24 * time.Hour).Truncate(time.Second)
	if _, err := f.db.Exec(ctx, `UPDATE event_session SET starts_at = $2, ends_at = $3 WHERE id = $1`, s.ID, moved, moved.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.SyncSessionStart(ctx, f.tenant, s.ID); err != nil {
		t.Fatal(err)
	}
	if _, at := bookingRow(t, f, b.ID); at == nil || !at.Equal(moved) {
		t.Fatalf("after sync starts_at = %v, want %v", at, moved)
	}

	if _, err := f.db.Exec(ctx, `UPDATE event_booking SET starts_at = NULL WHERE id = $1`, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := (&eventModule{}).Migrate(ctx, f.db); err != nil {
		t.Fatal(err)
	}
	if _, at := bookingRow(t, f, b.ID); at == nil || !at.Equal(moved) {
		t.Fatalf("after Migrate starts_at = %v, want %v (backfilled)", at, moved)
	}
}
