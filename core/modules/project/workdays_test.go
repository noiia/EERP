package project

import (
	"math"
	"testing"
	"time"
)

// exchangeDay is a UTC midnight date, the shape every Plan date carries: the
// exchange columns are TIMESTAMPTZ, and the model only ever stores the day.
func exchangeDay(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// The 2026-01-05 week, used by every case: Mon 5, Tue 6, Wed 7, Thu 8, Fri 9,
// Sat 10, Sun 11, Mon 12.
var (
	monday     = exchangeDay(2026, time.January, 5)
	tuesday    = exchangeDay(2026, time.January, 6)
	wednesday  = exchangeDay(2026, time.January, 7)
	thursday   = exchangeDay(2026, time.January, 8)
	friday     = exchangeDay(2026, time.January, 9)
	saturday   = exchangeDay(2026, time.January, 10)
	sunday     = exchangeDay(2026, time.January, 11)
	nextMonday = exchangeDay(2026, time.January, 12)

	// zeroDay is the date a Plan holds when the file set none at all (see ganDay):
	// time.Time{} itself, which day() normalises to the UTC midnight of year 1.
	zeroDay = time.Time{}
)

// fridayOff is a calendar with Friday off too, to prove the mask is honoured
// rather than Saturday/Sunday being hardcoded.
var fridayOff = Weekend{time.Friday: true, time.Saturday: true, time.Sunday: true}

// everyDay works all seven days: the mask a file writes with <default-week
// sun="0" ... sat="0"/>, and the one where a duration costs exactly that many
// days of walking.
var everyDay = Weekend{}

// worksOnly builds the mask that works exactly these weekdays and none other.
func worksOnly(days ...time.Weekday) Weekend {
	w := Weekend{}
	for i := range w {
		w[i] = true
	}
	for _, d := range days {
		w[d] = false
	}
	return w
}

// mondaysOnly is the sparsest calendar that still works a day. It is the worst
// case for the day loops: seven calendar days walked per worked day.
var mondaysOnly = worksOnly(time.Monday)

// noWorkday is not a calendar at all, it works nothing: the mask of a
// <default-week sun="1" ... sat="1"/>. The .gan decoder refuses such a file
// (see TestGanDecode_Calendar), and these two functions have to stay bounded on
// it anyway, because their caller is not always the decoder.
var noWorkday = worksOnly()

// within runs fn and fails the test if it has not returned in d. The two day
// loops are bounded, so this turns a regression into a named failure rather than
// a package timeout ten minutes later.
func within(t *testing.T, d time.Duration, what string, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("%s did not return within %v: the day loop is not bounded", what, d)
	}
}

func TestWorkdays(t *testing.T) {
	t.Run("workdaysBetween", func(t *testing.T) {
		cases := []struct {
			name       string
			start, end time.Time
			w          Weekend
			want       int
		}{
			{"full working week", monday, friday, DefaultWeekend, 5},
			{"across the weekend", friday, nextMonday, DefaultWeekend, 2},
			{"weekend only counts one", saturday, sunday, DefaultWeekend, 1},
			{"single worked day", wednesday, wednesday, DefaultWeekend, 1},
			{"single unworked day", saturday, saturday, DefaultWeekend, 1},
			{"whole week with Friday off", monday, friday, fridayOff, 4},
			{"longer span", monday, exchangeDay(2026, time.January, 30), DefaultWeekend, 20},
			{"end before start", friday, monday, DefaultWeekend, 0},
			{"times of day are ignored", monday.Add(9 * time.Hour), friday.Add(17 * time.Hour), DefaultWeekend, 5},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				if got := workdaysBetween(tc.start, tc.end, tc.w); got != tc.want {
					t.Errorf("workdaysBetween(%v, %v) = %d, want %d", tc.start.UTC().Format("2006-01-02"), tc.end.UTC().Format("2006-01-02"), got, tc.want)
				}
			})
		}
	})

	t.Run("endAfter", func(t *testing.T) {
		cases := []struct {
			name     string
			start    time.Time
			duration int
			w        Weekend
			want     time.Time
		}{
			{"five worked days from Monday", monday, 5, DefaultWeekend, friday},
			{"two worked days from Friday", friday, 2, DefaultWeekend, nextMonday},
			{"one day lands on the start", monday, 1, DefaultWeekend, monday},
			{"one day on a Saturday still lands on the Saturday", saturday, 1, DefaultWeekend, saturday},
			{"zero is the start", monday, 0, DefaultWeekend, monday},
			{"negative is the start", friday, -3, DefaultWeekend, friday},
			{"duration counts worked days only", monday, 6, DefaultWeekend, nextMonday},
			{"mask with Friday off", monday, 5, fridayOff, nextMonday},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				got := endAfter(tc.start, tc.duration, tc.w)
				if !got.Equal(tc.want) {
					t.Errorf("endAfter(%v, %d) = %v, want %v", tc.start.UTC().Format("2006-01-02"), tc.duration, got.UTC().Format("2006-01-02"), tc.want.UTC().Format("2006-01-02"))
				}
				if got.Location() != time.UTC {
					t.Errorf("endAfter(%v, %d) = %v, want UTC", tc.start, tc.duration, got)
				}
			})
		}
	})

	t.Run("no worked day", func(t *testing.T) {
		// A mask that works nothing is not a calendar. The loops still have to
		// answer and come back: a span inside a run of non-worked days counts the
		// one day it occupies, and a duration stays on its own start's day rather
		// than walking forever looking for a day that never comes.
		cases := []struct {
			name       string
			start, end time.Time
			want       int
		}{
			{"one day", monday, monday, 1},
			{"a project's length", monday, exchangeDay(2026, time.June, 5), 1},
			{"a span no schedule explains", monday, exchangeDay(2200, time.January, 1), 1},
			{"end before start", friday, monday, 0},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				within(t, 30*time.Second, "workdaysBetween with no worked day", func() {
					if got := workdaysBetween(tc.start, tc.end, noWorkday); got != tc.want {
						t.Errorf("workdaysBetween(%v, %v, noWorkday) = %d, want %d", tc.start, tc.end, got, tc.want)
					}
				})
			})
		}
		within(t, 30*time.Second, "endAfter with no worked day", func() {
			if got := endAfter(monday, 5, noWorkday); !got.Equal(monday) {
				t.Errorf("endAfter(Mon, 5, noWorkday) = %v, want the start's own day", got)
			}
			if got := endAfter(saturday, 40, noWorkday); !got.Equal(saturday) {
				t.Errorf("endAfter(Sat, 40, noWorkday) = %v, want the start's own day", got)
			}
		})
	})

	t.Run("zero start", func(t *testing.T) {
		// time.Time{} is what a Plan carries when the file set no date at all (see
		// ganDay), so the two functions meet it for real: it is a day like any
		// other, the UTC midnight of year 1 January 1, and neither function may
		// invent a date for it or fall over on it.
		zero := zeroDay
		if got := day(zero); !got.Equal(exchangeDay(1, 1, 1)) {
			t.Errorf("day(zero) = %v, want 0001-01-01 UTC", got)
		}
		if got := workdaysBetween(zero, zero, DefaultWeekend); got != 1 {
			t.Errorf("workdaysBetween(zero, zero) = %d, want 1", got)
		}
		if got := endAfter(zero, 0, DefaultWeekend); !got.Equal(day(zero)) {
			t.Errorf("endAfter(zero, 0) = %v, want the zero day", got)
		}
		if got := endAfter(zero, 1, DefaultWeekend); !got.Equal(day(zero)) {
			t.Errorf("endAfter(zero, 1) = %v, want the zero day", got)
		}
		// A duration from the zero day counts worked days from there, not from today.
		if got := workdaysBetween(zero, endAfter(zero, 5, DefaultWeekend), DefaultWeekend); got != 5 {
			t.Errorf("workdaysBetween(zero, endAfter(zero, 5)) = %d, want 5", got)
		}
		// A whole duration's worth of days walked from the zero day is still a whole
		// day at UTC, and stays on this side of the ceiling.
		got := endAfter(zero, 40, DefaultWeekend)
		if got.Location() != time.UTC || got.Format("15:04:05") != "00:00:00" {
			t.Errorf("endAfter(zero, 40) = %s, want UTC midnight", got)
		}
		if !got.After(zero) {
			t.Errorf("endAfter(zero, 40) = %v, want a day after the zero day", got)
		}
	})

	t.Run("ceiling", func(t *testing.T) {
		// Every bound of the two loops comes from data EERP does not choose: the
		// dates of a database row, the duration of a file. Both saturate at
		// maxWorkdayCount instead of spinning, and the two stay consistent about it.
		for _, start := range []time.Time{monday, saturday, zeroDay} {
			want := endAfter(start, maxWorkdayCount, DefaultWeekend)
			for _, n := range []int{maxWorkdayCount + 1, 2 * maxWorkdayCount, math.MaxInt} {
				within(t, 30*time.Second, "endAfter past the ceiling", func() {
					if got := endAfter(start, n, DefaultWeekend); !got.Equal(want) {
						t.Errorf("endAfter(%v, %d) = %v, want the ceiling's own day %v", start, n, got, want)
					}
				})
			}
		}

		// A span past every horizon counts the ceiling, not 700 years of days.
		within(t, 30*time.Second, "workdaysBetween over a huge span", func() {
			if got := workdaysBetween(monday, monday.AddDate(0, 0, 2*maxWorkdayScan), DefaultWeekend); got != maxWorkdayCount {
				t.Errorf("workdaysBetween over twice the scan budget = %d, want it capped at %d", got, maxWorkdayCount)
			}
			// The sparsest calendar still reaches the ceiling exactly, which is what
			// keeps the two functions inverses at the ceiling and not only below it.
			end := endAfter(monday, maxWorkdayCount, mondaysOnly)
			if got := workdaysBetween(monday, end, mondaysOnly); got != maxWorkdayCount {
				t.Errorf("workdaysBetween at the ceiling with one worked day = %d, want %d", got, maxWorkdayCount)
			}
		})
	})

	t.Run("day", func(t *testing.T) {
		if got := day(monday.Add(23 * time.Hour)); !got.Equal(monday) {
			t.Errorf("day(23:00 UTC) = %v, want %v", got, monday)
		}
		// 01:00 in +02:00 is 23:00 UTC the day before: the UTC date decides.
		plus2 := time.FixedZone("plus2", 2*60*60)
		if got := day(time.Date(2026, time.January, 5, 1, 0, 0, 0, plus2)); !got.Equal(exchangeDay(2026, time.January, 4)) {
			t.Errorf("day(01:00+02:00) = %v, want 2026-01-04", got)
		}
		if got := day(tuesday); !got.Equal(tuesday) {
			t.Errorf("day(already midnight) = %v, want %v", got, tuesday)
		}
	})

	t.Run("DefaultWeekend", func(t *testing.T) {
		if DefaultWeekend != (Weekend{time.Saturday: true, time.Sunday: true}) {
			t.Errorf("DefaultWeekend = %v, want Saturday and Sunday off", DefaultWeekend)
		}
		for _, wd := range []time.Weekday{time.Monday, time.Tuesday, time.Wednesday, time.Thursday, time.Friday} {
			if DefaultWeekend[wd] {
				t.Errorf("DefaultWeekend[%v] = true, want worked", wd)
			}
		}
		for _, wd := range []time.Weekday{time.Saturday, time.Sunday} {
			if !DefaultWeekend[wd] {
				t.Errorf("DefaultWeekend[%v] = false, want not worked", wd)
			}
		}
	})

	t.Run("hasWorkedDay", func(t *testing.T) {
		for _, w := range []Weekend{DefaultWeekend, fridayOff, everyDay, mondaysOnly} {
			if !w.hasWorkedDay() {
				t.Errorf("hasWorkedDay(%v) = false, want true", w)
			}
		}
		if noWorkday.hasWorkedDay() {
			t.Error("hasWorkedDay(noWorkday) = true, want false: no day of it is ever worked")
		}
	})
}

// TestWorkdaysInverse pins the property the whole exchange rests on: for any
// start day, any calendar that works at least one day, and any duration up to the
// ceiling, the end date endAfter gives is exactly the day that lasts n working
// days from that start.
//
// It is the one place the two functions are checked against each other rather than
// against a table of hand-picked dates, and it is what the diff depends on: a
// duration read from a file turns into the end the file means, and the same pair
// read back from the database gives the same duration. A drift between the two
// shows up as spurious date change rows on a file nobody touched.
//
// Every weekday starts the walk, including a start that is itself a non-worked day
// (the Saturday a weekend deadline lands on), and the zero day, which is what a
// file with no start attribute carries.
func TestWorkdaysInverse(t *testing.T) {
	masks := []struct {
		name string
		w    Weekend
	}{
		{"default", DefaultWeekend},
		{"friday off", fridayOff},
		{"every day", everyDay},
		{"mondays only", mondaysOnly},
	}
	starts := []time.Time{
		monday, tuesday, wednesday, thursday, friday, saturday, sunday, nextMonday,
		exchangeDay(2026, time.January, 31), // a Saturday at the end of a 31 day month
		exchangeDay(2026, time.March, 1),    // across a month boundary
		zeroDay,
	}
	durations := []int{1, 2, 3, 4, 5, 6, 7, 8, 13, 20, 21, 22, 27, 40, 100, 365, 400}

	for _, tm := range masks {
		t.Run(tm.name, func(t *testing.T) {
			if !tm.w.hasWorkedDay() {
				t.Fatalf("mask %q works no day, the inverse property is stated for the ones that do", tm.name)
			}
			for _, start := range starts {
				for _, n := range durations {
					end := endAfter(start, n, tm.w)
					if got := workdaysBetween(start, end, tm.w); got != n {
						t.Errorf("workdaysBetween(%v, endAfter(%v, %d)) = %d, want %d",
							start, start, n, got, n)
					}
					// The end is a day the plan can hold: never before its start,
					// always a whole UTC day.
					if end.Before(day(start)) {
						t.Errorf("endAfter(%v, %d) = %v, want on or after %v", start, n, end, day(start))
					}
					if end.Location() != time.UTC || end.Format("15:04:05") != "00:00:00" {
						t.Errorf("endAfter(%v, %d) = %s, want UTC midnight", start, n, end)
					}
					// Walking one worked day further is one more working day, which is
					// the same property read one step at a time.
					if next := endAfter(end, 2, tm.w); !next.After(end) {
						t.Errorf("endAfter(%v, 2) = %v, want a day after %v", end, next, end)
					}
				}
			}

			// The ceiling itself, where the two functions still agree: the last
			// duration EERP can carry gives the day whose count is exactly that.
			for _, start := range []time.Time{monday, saturday, zeroDay} {
				end := endAfter(start, maxWorkdayCount, tm.w)
				if got := workdaysBetween(start, end, tm.w); got != maxWorkdayCount {
					t.Errorf("at the ceiling: workdaysBetween(%v, endAfter(%v, %d)) = %d, want %d",
						start, start, maxWorkdayCount, got, maxWorkdayCount)
				}
			}
		})
	}
}
