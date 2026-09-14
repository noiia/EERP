package sale

import (
	"context"
	"fmt"
	"time"

	"core/orm"
)

// ExpireOverdueQuotes flips every quote whose "valid until" date (DueDate)
// has passed and whose status hasn't reached a terminal outcome yet to
// "expired". Meant to run periodically (see main.go's quote expiry ticker),
// mirroring internal/cron's own SweepHistory shape (retention.go): fetch
// every row, apply a pure per-row decision, across every tenant in one
// sweep (no per-request tenant scope) — runs, and errors, per row so one
// bad row never blocks the sweep of every other row.
func ExpireOverdueQuotes(ctx context.Context, quotes *orm.Repository[Quote]) error {
	rows, err := quotes.FindAll(ctx)
	if err != nil {
		return fmt.Errorf("sale: list quotes: %w", err)
	}
	now := time.Now()
	for _, q := range rows {
		if !quoteOverdue(q, now) {
			continue
		}
		q.Status = "expired"
		if _, err := quotes.Update(ctx, q, q.ID); err != nil {
			return fmt.Errorf("sale: expire quote %s: %w", q.ID, err)
		}
	}
	return nil
}

// quoteOverdue is the pure cutoff decision ExpireOverdueQuotes applies per
// row — pulled out so the date/status logic is unit-testable without a
// database (mirrors internal/cron/retention.go's historyExpired). A quote
// with no DueDate never expires (nothing to compare against); only
// draft/confirmed/sent are "in flight" — accepted/declined/expired are
// already terminal and must never be touched again.
func quoteOverdue(q Quote, now time.Time) bool {
	if q.DueDate == nil {
		return false
	}
	switch q.Status {
	case "draft", "confirmed", "sent":
	default:
		return false
	}
	return q.DueDate.Before(now)
}
