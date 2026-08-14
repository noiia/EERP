package cron

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestHistoryExpired(t *testing.T) {
	now := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
	cronA := uuid.New()

	cases := []struct {
		name      string
		createdAt time.Time
		retention map[uuid.UUID]int
		cronID    uuid.UUID
		want      bool
	}{
		{
			name:      "within default 1-year window",
			createdAt: now.AddDate(0, -6, 0),
			retention: map[uuid.UUID]int{},
			cronID:    cronA,
			want:      false,
		},
		{
			name:      "past default 1-year window",
			createdAt: now.AddDate(-1, 0, -1),
			retention: map[uuid.UUID]int{},
			cronID:    cronA,
			want:      true,
		},
		{
			name:      "exactly at the cutoff instant is expired (inclusive: a row must survive LESS than the window, not exactly it)",
			createdAt: now.AddDate(-1, 0, 0),
			retention: map[uuid.UUID]int{},
			cronID:    cronA,
			want:      true,
		},
		{
			name:      "custom retention overrides the default",
			createdAt: now.AddDate(-1, -1, 0),
			retention: map[uuid.UUID]int{cronA: 2},
			cronID:    cronA,
			want:      false,
		},
		{
			name:      "zero retention on the owning cron falls back to the default",
			createdAt: now.AddDate(-1, 0, -1),
			retention: map[uuid.UUID]int{cronA: 0},
			cronID:    cronA,
			want:      true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := CronHistory{CronID: tc.cronID}
			h.CreatedAt = tc.createdAt
			got := historyExpired(h, tc.retention, now)
			if got != tc.want {
				t.Errorf("historyExpired() = %v, want %v", got, tc.want)
			}
		})
	}
}
