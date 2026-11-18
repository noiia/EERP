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

// worked reports whether t's day is worked under the mask.
func (w Weekend) worked(t time.Time) bool {
	return !w[int(t.Weekday())]
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
// every duration the encoder can write.
//
// The loop is a day at a time on purpose: spans come from a duration clamped at
// decode time (see ganMaxDurationDays), so it stays short.
func workdaysBetween(start, end time.Time, w Weekend) int {
	a, b := day(start), day(end)
	if b.Before(a) {
		return 0
	}
	n := 0
	for d := a; !d.After(b); d = d.AddDate(0, 0, 1) {
		if w.worked(d) {
			n++
		}
	}
	if n == 0 {
		return 1
	}
	return n
}

// endAfter returns the day of the duration-th worked day counted from start,
// where start itself counts as the first when it is worked. It is the inverse of
// workdaysBetween: when start is a worked day, endAfter(start, n, w) is the day
// d that satisfies workdaysBetween(start, d, w) == n.
//
// duration ≤ 1 returns start (day-normalised): a milestone and an undated
// placeholder both sit on their day whatever the calendar, even a Saturday.
func endAfter(start time.Time, duration int, w Weekend) time.Time {
	d := day(start)
	if duration <= 1 {
		return d
	}
	for n := 1; ; d = d.AddDate(0, 0, 1) {
		if !w.worked(d) {
			continue
		}
		if n == duration {
			return d
		}
		n++
	}
}
