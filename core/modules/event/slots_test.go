package event

import (
	"testing"
	"time"
)

func TestExpandSlots(t *testing.T) {
	paris, _ := time.LoadLocation("Europe/Paris")
	rules := SlotRules{SlotMinutes: 30, BufferMinutes: 0, HorizonDays: 60, MinNoticeHours: 2, Loc: paris}
	monday9to10 := []EventAvailability{{Weekday: 1, FromTime: "09:00", ToTime: "10:00"}}
	at := func(s string) time.Time { v, _ := time.ParseInLocation("2006-01-02 15:04", s, paris); return v }

	t.Run("two 30-minute slots in one hour", func(t *testing.T) {
		now := at("2026-09-27 12:00") // Sunday
		got := ExpandSlots(rules, monday9to10, at("2026-09-28 00:00"), at("2026-09-29 00:00"), now)
		if len(got) != 2 || !got[0].Start.Equal(at("2026-09-28 09:00")) || !got[1].End.Equal(at("2026-09-28 10:00")) {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("buffer spaces slots", func(t *testing.T) {
		r := rules
		r.BufferMinutes = 15
		got := ExpandSlots(r, []EventAvailability{{Weekday: 1, FromTime: "09:00", ToTime: "10:30"}}, at("2026-09-28 00:00"), at("2026-09-29 00:00"), at("2026-09-27 00:00"))
		// 09:00-09:30, 09:45-10:15; 10:30 would end 11:00 > 10:30
		if len(got) != 2 || !got[1].Start.Equal(at("2026-09-28 09:45")) {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("min notice drops too-soon slots", func(t *testing.T) {
		got := ExpandSlots(rules, monday9to10, at("2026-09-28 00:00"), at("2026-09-29 00:00"), at("2026-09-28 07:15"))
		// now+2h = 09:15 → 09:00 dropped, 09:30 kept
		if len(got) != 1 || !got[0].Start.Equal(at("2026-09-28 09:30")) {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("horizon drops far slots", func(t *testing.T) {
		r := rules
		r.HorizonDays = 1
		got := ExpandSlots(r, monday9to10, at("2026-10-05 00:00"), at("2026-10-06 00:00"), at("2026-09-28 12:00"))
		if len(got) != 0 {
			t.Fatalf("got %v, want none beyond the horizon", got)
		}
	})

	// Review Focus #2: DST start (Sun 2026-03-29) and end (Sun 2026-10-25) in Paris.
	t.Run("DST keeps local wall-clock times", func(t *testing.T) {
		sunday9 := []EventAvailability{{Weekday: 0, FromTime: "09:00", ToTime: "09:30"}}
		for _, day := range []string{"2026-03-22", "2026-03-29", "2026-10-18", "2026-10-25"} {
			d := at(day + " 00:00")
			got := ExpandSlots(rules, sunday9, d, d.AddDate(0, 0, 1), d.AddDate(0, 0, -7))
			if len(got) != 1 || got[0].Start.In(paris).Hour() != 9 || got[0].End.Sub(got[0].Start) != 30*time.Minute {
				t.Fatalf("%s: got %v", day, got)
			}
		}
		// The UTC hour differs across the change, proving local time was used.
		before := ExpandSlots(rules, sunday9, at("2026-03-22 00:00"), at("2026-03-23 00:00"), at("2026-03-01 00:00"))[0]
		after := ExpandSlots(rules, sunday9, at("2026-03-29 00:00"), at("2026-03-30 00:00"), at("2026-03-01 00:00"))[0]
		if before.Start.UTC().Hour() == after.Start.UTC().Hour() {
			t.Error("UTC hour unchanged across DST start")
		}
	})

	t.Run("availability with to_time <= from_time yields no slots", func(t *testing.T) {
		// Defensive test: invalid availability should not crash
		got := ExpandSlots(rules, []EventAvailability{{Weekday: 1, FromTime: "10:00", ToTime: "10:00"}}, at("2026-09-28 00:00"), at("2026-09-29 00:00"), at("2026-09-27 00:00"))
		if len(got) != 0 {
			t.Fatalf("got %v, want no slots for to_time = from_time", got)
		}

		got2 := ExpandSlots(rules, []EventAvailability{{Weekday: 1, FromTime: "10:30", ToTime: "10:00"}}, at("2026-09-28 00:00"), at("2026-09-29 00:00"), at("2026-09-27 00:00"))
		if len(got2) != 0 {
			t.Fatalf("got %v, want no slots for to_time < from_time", got2)
		}
	})

	t.Run("negative buffer returns no slots (step <= 0)", func(t *testing.T) {
		r := rules
		// With 30min slots and -30min buffer, step would be 0, returning nil
		negBuffer := -30
		r.BufferMinutes = negBuffer
		got := ExpandSlots(r, monday9to10, at("2026-09-28 00:00"), at("2026-09-29 00:00"), at("2026-09-27 00:00"))
		if got != nil {
			t.Fatalf("got %v, want nil for step <= 0", got)
		}
	})
}

func TestRulesFor(t *testing.T) {
	tests := []struct {
		name    string
		event   Event
		wantErr bool
		check   func(r SlotRules) bool
	}{
		{
			name: "nil BufferMinutes → 0",
			event: Event{
				Timezone:           "Europe/Paris",
				SlotMinutes:        30,
				BufferMinutes:      nil,
				BookingHorizonDays: 60,
				MinNoticeHours:     2,
			},
			wantErr: false,
			check: func(r SlotRules) bool {
				return r.BufferMinutes == 0
			},
		},
		{
			name: "negative BufferMinutes → 0",
			event: Event{
				Timezone:           "Europe/Paris",
				SlotMinutes:        30,
				BufferMinutes:      func() *int { v := -15; return &v }(),
				BookingHorizonDays: 60,
				MinNoticeHours:     2,
			},
			wantErr: false,
			check: func(r SlotRules) bool {
				return r.BufferMinutes == 0
			},
		},
		{
			name: "empty Timezone → Europe/Paris",
			event: Event{
				Timezone:           "",
				SlotMinutes:        30,
				BufferMinutes:      nil,
				BookingHorizonDays: 60,
				MinNoticeHours:     2,
			},
			wantErr: false,
			check: func(r SlotRules) bool {
				return r.Loc != nil && r.Loc.String() == "Europe/Paris"
			},
		},
		{
			name: "invalid Timezone → error",
			event: Event{
				Timezone:           "Invalid/Zone",
				SlotMinutes:        30,
				BufferMinutes:      nil,
				BookingHorizonDays: 60,
				MinNoticeHours:     2,
			},
			wantErr: true,
			check:   nil,
		},
		{
			name: "min_notice 0 stays 0",
			event: Event{
				Timezone:           "Europe/Paris",
				SlotMinutes:        30,
				BufferMinutes:      nil,
				BookingHorizonDays: 60,
				MinNoticeHours:     0,
			},
			wantErr: false,
			check: func(r SlotRules) bool {
				return r.MinNoticeHours == 0
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, err := RulesFor(tt.event)
			if (err != nil) != tt.wantErr {
				t.Fatalf("RulesFor error = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && !tt.check(r) {
				t.Fatalf("RulesFor check failed: %+v", r)
			}
		})
	}
}
