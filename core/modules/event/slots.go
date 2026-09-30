package event

import (
	"fmt"
	"sort"
	"time"
)

type Slot struct{ Start, End time.Time }

type SlotRules struct {
	SlotMinutes, BufferMinutes, HorizonDays, MinNoticeHours int
	Loc                                                     *time.Location
}

// RulesFor builds a SlotRules from an Event, loading its timezone and dereferencing
// BufferMinutes (nil → 0, negative → 0). Stored int fields are used AS-IS; the POST
// validation middleware fills defaults, so 0 is legitimate (e.g., "no notice required").
// Empty Timezone defaults to Europe/Paris; invalid names return an error.
func RulesFor(e Event) (SlotRules, error) {
	tz := e.Timezone
	if tz == "" {
		tz = "Europe/Paris"
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return SlotRules{}, fmt.Errorf("event %s: timezone: %w", e.ID, err)
	}

	buffer := 0
	if e.BufferMinutes != nil {
		buffer = *e.BufferMinutes
		if buffer < 0 {
			buffer = 0
		}
	}

	return SlotRules{
		SlotMinutes:    e.SlotMinutes,
		BufferMinutes:  buffer,
		HorizonDays:    e.BookingHorizonDays,
		MinNoticeHours: e.MinNoticeHours,
		Loc:            loc,
	}, nil
}

// ExpandSlots lists every slot the availability generates in [from, to),
// keeping only those starting after now+min notice and before now+horizon.
// Wall-clock times are built with time.Date in r.Loc, so DST shifts the UTC
// instant, never the local hour. Capacity is NOT considered here.
func ExpandSlots(r SlotRules, avail []EventAvailability, from, to, now time.Time) []Slot {
	if r.SlotMinutes <= 0 {
		return nil
	}
	slot := time.Duration(r.SlotMinutes) * time.Minute
	step := slot + time.Duration(r.BufferMinutes)*time.Minute
	if step <= 0 {
		return nil
	}
	earliest := now.Add(time.Duration(r.MinNoticeHours) * time.Hour)
	latest := now.AddDate(0, 0, r.HorizonDays)
	var out []Slot
	f := from.In(r.Loc)
	for day := time.Date(f.Year(), f.Month(), f.Day(), 0, 0, 0, 0, r.Loc); day.Before(to); day = day.AddDate(0, 0, 1) {
		for _, a := range avail {
			if int(day.Weekday()) != a.Weekday {
				continue
			}
			start, ok1 := clock(day, a.FromTime, r.Loc)
			end, ok2 := clock(day, a.ToTime, r.Loc)
			if !ok1 || !ok2 || !start.Before(end) {
				continue
			}
			for s := start; !s.Add(slot).After(end); s = s.Add(step) {
				if s.Before(from) || !s.Before(to) || s.Before(earliest) || !s.Before(latest) {
					continue
				}
				out = append(out, Slot{Start: s, End: s.Add(slot)})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start.Before(out[j].Start) })
	return out
}

func clock(day time.Time, hhmm string, loc *time.Location) (time.Time, bool) {
	t, err := time.Parse("15:04", hhmm)
	if err != nil {
		return time.Time{}, false
	}
	return time.Date(day.Year(), day.Month(), day.Day(), t.Hour(), t.Minute(), 0, 0, loc), true
}
