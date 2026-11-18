package project

import (
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
)

// fridayOff is a calendar with Friday off too, to prove the mask is honoured
// rather than Saturday/Sunday being hardcoded.
var fridayOff = Weekend{time.Friday: true, time.Saturday: true, time.Sunday: true}

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
}
