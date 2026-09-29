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

// RulesFor builds a SlotRules from an Event, loading its timezone and providing
// sensible defaults for optional fields (BufferMinutes defaults to 0 if nil;
// zero-valued int fields use their schema-documented defaults).
func RulesFor(e Event) (SlotRules, error) {
	loc, err := time.LoadLocation(e.Timezone)
	if err != nil {
		return SlotRules{}, fmt.Errorf("event %s: timezone: %w", e.ID, err)
	}

	buffer := 0
	if e.BufferMinutes != nil {
		buffer = *e.BufferMinutes
	}

	slotMinutes := e.SlotMinutes
	if slotMinutes == 0 {
		slotMinutes = 30
	}

	horizonDays := e.BookingHorizonDays
	if horizonDays == 0 {
		horizonDays = 60
	}

	minNoticeHours := e.MinNoticeHours
	if minNoticeHours == 0 {
		minNoticeHours = 2
	}

	return SlotRules{
		SlotMinutes:    slotMinutes,
		BufferMinutes:  buffer,
		HorizonDays:    horizonDays,
		MinNoticeHours: minNoticeHours,
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
	earliest := now.Add(time.Duration(r.MinNoticeHours) * time.Hour)
	latest := now.AddDate(0, 0, r.HorizonDays)
	slot := time.Duration(r.SlotMinutes) * time.Minute
	step := slot + time.Duration(r.BufferMinutes)*time.Minute
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
