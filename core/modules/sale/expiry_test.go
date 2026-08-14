package sale

import (
	"testing"
	"time"
)

func TestQuoteOverdue(t *testing.T) {
	now := time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC)
	past := now.AddDate(0, 0, -1)
	future := now.AddDate(0, 0, 1)

	tests := []struct {
		name   string
		status string
		due    *time.Time
		want   bool
	}{
		{"no due date never expires", "draft", nil, false},
		{"draft past due date expires", "draft", &past, true},
		{"confirmed past due date expires", "confirmed", &past, true},
		{"sent past due date expires", "sent", &past, true},
		{"draft not yet due does not expire", "draft", &future, false},
		{"accepted past due date stays accepted (terminal)", "accepted", &past, false},
		{"declined past due date stays declined (terminal)", "declined", &past, false},
		{"already expired stays expired (terminal, not re-touched)", "expired", &past, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			q := Quote{Status: tt.status, DueDate: tt.due}
			if got := quoteOverdue(q, now); got != tt.want {
				t.Errorf("quoteOverdue() = %v, want %v", got, tt.want)
			}
		})
	}
}
