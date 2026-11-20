package project

import "time"

// Weekend is a weekday mask, indexed by time.Weekday: true means the day is not
// worked. It is the exchange counterpart of GanttProject's <default-week>
// element (its sun="1" ... sat="1" attributes), and the only calendar the
// exchange understands: file holidays are ignored, with a warning (see
// Plan.HasHolidays).
type Weekend [7]bool

// DefaultWeekend is Saturday and Sunday off: what a plain five-day week looks
// like, and the calendar assumed by a file that carries no <default-week>.
var DefaultWeekend = Weekend{time.Saturday: true, time.Sunday: true}

// Both functions below walk a calendar one day at a time, and every bound of
// that walk comes from data EERP does not choose: the span of workdaysBetween
// from the two dates a manager typed (Task 4's loader derives a Duration from
// them), the duration of endAfter from a file (Task 5's diff calls it), and the
// mask from either. Left alone, a mask that works no day or a deadline in the
// year 290000 turns one preview request into a pinned CPU. The two constants
// are the ceiling that makes each function safe on its own; the .gan decoder
// adds its own guard on the mask (see ganProjectEl.calendar), so neither
// function depends on the other layer being sane.
const (
	// maxWorkdayCount is the largest working-day count either function treats as a
	// schedule. 36500 working days is about a century and a half of five-day
	// weeks: past it a value is hostile or corrupt, not a plan. Both functions
	// saturate at the same point, so they stay inverses of each other at the
	// ceiling as well as below it (see the inverse property on endAfter).
	maxWorkdayCount = 36500

	// maxWorkdayScan caps the calendar days either loop walks, which is what
	// terminates them when no day is ever worked. The sparsest calendar that still
	// works a day is one worked day a week, needing seven calendar days walked per
	// worked day; the slack is the part-week walked before the first one.
	maxWorkdayScan = maxWorkdayCount*7 + 7
)

// worked reports whether t's day is worked under the mask.
func (w Weekend) worked(t time.Time) bool {
	return !w[int(t.Weekday())]
}

// hasWorkedDay reports whether the mask works at least one day of the week. A
// mask with none is not a calendar: the two functions below stay bounded on it
// (such a span counts as the one day it occupies, and a duration keeps its
// start's own day), but no schedule can be built on it, so a file that claims
// one is refused outright (see ganProjectEl.calendar). The inverse property on
// endAfter is stated for the masks that do have a worked day.
func (w Weekend) hasWorkedDay() bool {
	for _, off := range w {
		if !off {
			return true
		}
	}
	return false
}

// day returns t's UTC date at midnight. Every date a Plan carries is a whole
// day stored as UTC midnight, so the exchange columns (TIMESTAMPTZ) hold no
// time-of-day and two dates are comparable with ==.
func day(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// workdaysBetween counts the worked days from start to end, both ends included.
// It is the file's view of a duration: a task starting on start and ending on
// end lasts workdaysBetween(start, end) working days.
//
// A span with end before start counts 0. Any other span counts at least 1, even
// a weekend-only one: a task squeezed between Saturday and Sunday still occupies
// a day, and that keeps workdaysBetween and endAfter inverses of each other for
// every duration the encoder can write. A span inside a run of non-worked days,
// including a mask that works no day at all, is such a span: it counts 1.
//
// The loop is a day at a time on purpose: a real span is a project's length. It
// stops at maxWorkdayScan walked days and at maxWorkdayCount worked days, so a
// date from a corrupt row cannot spin it; a span past either is not a schedule,
// and the count saturates at maxWorkdayCount, the same ceiling endAfter clamps a
// duration to.
func workdaysBetween(start, end time.Time, w Weekend) int {
	a, b := day(start), day(end)
	if b.Before(a) {
		return 0
	}
	n := 0
	for d, walked := a, 0; !d.After(b) && walked < maxWorkdayScan; d, walked = d.AddDate(0, 0, 1), walked+1 {
		if !w.worked(d) {
			continue
		}
		n++
		if n == maxWorkdayCount {
			break
		}
	}
	if n == 0 {
		return 1
	}
	return n
}

// endAfter returns the day of the duration-th worked day counted from start,
// where start itself counts as the first when it is worked. It is the inverse of
// workdaysBetween: for a mask that works at least one day
// (see hasWorkedDay) and any duration up to maxWorkdayCount,
// workdaysBetween(start, endAfter(start, n, w), w) == n.
//
// duration ≤ 1 returns start (day-normalised): a milestone and an undated
// placeholder both sit on their day whatever the calendar, even a Saturday.
// A longer duration is clamped to maxWorkdayCount, so the answer saturates
// rather than running past any horizon; when even that many worked days do not
// fit inside maxWorkdayScan walked days (a mask with too few worked days), the
// last worked day reached comes back, or start's own day when the mask works
// none. Either way the day is one the plan is already on, never a date EERP
// invented, and the loop always terminates.
func endAfter(start time.Time, duration int, w Weekend) time.Time {
	first := day(start)
	if duration <= 1 {
		return first
	}
	if duration > maxWorkdayCount {
		duration = maxWorkdayCount
	}
	last := first
	for d, walked, seen := first, 0, 0; walked < maxWorkdayScan; d, walked = d.AddDate(0, 0, 1), walked+1 {
		if !w.worked(d) {
			continue
		}
		seen++
		if seen == duration {
			return d
		}
		last = d
	}
	return last
}
