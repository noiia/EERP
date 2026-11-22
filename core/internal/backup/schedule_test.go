package backup

import (
	"testing"
	"time"
)

func TestNextSlot(t *testing.T) {
	at := func(s string) time.Time {
		v, err := time.Parse(time.RFC3339, s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	set := func(mut func(*Settings)) Settings { s := Defaults(); mut(&s); return s }
	tests := []struct {
		name  string
		s     Settings
		after string
		want  string
	}{
		{"daily before the time", set(func(*Settings) {}), "2026-11-22T01:59:00Z", "2026-11-22T02:00:00Z"},
		{"daily exactly at the time is strictly after", set(func(*Settings) {}), "2026-11-22T02:00:00Z", "2026-11-23T02:00:00Z"},
		{"weekly Mon+Thu in Paris from a Saturday",
			set(func(s *Settings) { s.Frequency, s.Weekdays, s.Time, s.Timezone = "weekly", []int{1, 4}, "03:00", "Europe/Paris" }),
			"2026-11-21T12:00:00Z", "2026-11-23T02:00:00Z"},
		{"weekly Mon+Thu from a Monday after the slot",
			set(func(s *Settings) { s.Frequency, s.Weekdays, s.Time, s.Timezone = "weekly", []int{1, 4}, "03:00", "Europe/Paris" }),
			"2026-11-23T05:00:00Z", "2026-11-26T02:00:00Z"},
		{"monthly 28th rolls into the next month",
			set(func(s *Settings) { s.Frequency, s.MonthDay = "monthly", 28 }),
			"2026-02-28T23:00:00Z", "2026-03-28T02:00:00Z"},
		{"every 6 hours anchored at 00:30",
			set(func(s *Settings) { s.Frequency, s.EveryHours, s.Time = "hours", 6, "00:30" }),
			"2026-11-22T07:00:00Z", "2026-11-22T12:30:00Z"},
		{"every 6 hours before the anchor",
			set(func(s *Settings) { s.Frequency, s.EveryHours, s.Time = "hours", 6, "23:30" }),
			"2026-11-22T00:00:00Z", "2026-11-22T05:30:00Z"},
		{"daily in a DST gap moves forward",
			set(func(s *Settings) { s.Time, s.Timezone = "02:30", "Europe/Paris" }),
			"2026-03-28T12:00:00Z", "2026-03-29T01:30:00Z"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NextSlot(tt.s, at(tt.after)); !got.Equal(at(tt.want)) {
				t.Errorf("NextSlot = %s, want %s", got.UTC().Format(time.RFC3339), tt.want)
			}
		})
	}
}
