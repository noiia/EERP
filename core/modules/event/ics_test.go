package event

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCalendar(t *testing.T) {
	start := time.Date(2026, 10, 5, 7, 0, 0, 0, time.UTC)
	loc := "Studio; floor 2, room \"B\""
	cal := Calendar{Method: MethodPublish, Name: "Yoga", Events: []CalendarEvent{{
		UID: "booking-" + uuid.Nil.String(), Start: start, End: start.Add(time.Hour), Summary: "Yoga, Pilates\nand more",
		Location: loc, Description: strings.Repeat("long ", 30), Sequence: 3,
	}}}
	out := string(cal.Bytes())
	for _, want := range []string{
		"BEGIN:VCALENDAR\r\n", "VERSION:2.0\r\n", "METHOD:PUBLISH\r\n",
		"UID:booking-00000000-0000-0000-0000-000000000000@eerp\r\n",
		"DTSTART:20261005T070000Z\r\n", "DTEND:20261005T080000Z\r\n",
		`SUMMARY:Yoga\, Pilates\nand more` + "\r\n",
		`LOCATION:Studio\; floor 2\, room "B"` + "\r\n",
		"SEQUENCE:3\r\n", "STATUS:CONFIRMED\r\n", "END:VCALENDAR\r\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("calendar lacks %q:\n%s", want, out)
		}
	}
	for _, line := range strings.Split(out, "\r\n") {
		if len(line) > 75 {
			t.Errorf("line longer than 75 octets: %q", line)
		}
	}
	if !strings.Contains(out, "\r\n ") {
		t.Errorf("a long description must fold with a leading space:\n%s", out)
	}

	cancel := Calendar{Method: MethodCancel, Events: []CalendarEvent{{UID: "x", Start: start, End: start, Cancelled: true}}}
	if c := string(cancel.Bytes()); !strings.Contains(c, "METHOD:CANCEL\r\n") || !strings.Contains(c, "STATUS:CANCELLED\r\n") {
		t.Errorf("cancel calendar:\n%s", c)
	}
}
