package backup

import (
	"slices"
	"time"
)

// NextSlot is the first scheduled time strictly after `after`. s must be
// valid (Validate). Local times are built with time.Date, which moves a time
// that falls in a DST gap forward.
func NextSlot(s Settings, after time.Time) time.Time {
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil {
		loc = time.UTC
	}
	hh, mm := int(s.Time[0]-'0')*10+int(s.Time[1]-'0'), int(s.Time[3]-'0')*10+int(s.Time[4]-'0')
	local := after.In(loc)
	at := func(dayOffset int) time.Time {
		return time.Date(local.Year(), local.Month(), local.Day()+dayOffset, hh, mm, 0, 0, loc)
	}

	if s.Frequency == "hours" {
		anchor, step := at(0), time.Duration(s.EveryHours)*time.Hour
		k := after.Sub(anchor) / step
		slot := anchor.Add(k * step)
		for !slot.After(after) {
			slot = slot.Add(step)
		}
		for slot.Add(-step).After(after) { // anchor ahead of `after`: step back
			slot = slot.Add(-step)
		}
		return slot
	}
	// 62 days cover every weekly and monthly (day ≤ 28) case.
	for d := 0; d <= 62; d++ {
		slot := at(d)
		if !slot.After(after) {
			continue
		}
		switch s.Frequency {
		case "weekly":
			if !slices.Contains(s.Weekdays, int(slot.Weekday())) {
				continue
			}
		case "monthly":
			if slot.Day() != s.MonthDay {
				continue
			}
		}
		return slot
	}
	return at(1) // unreachable with valid settings
}
