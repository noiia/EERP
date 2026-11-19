package sale

import (
	"context"
	"fmt"

	"core/orm"
)

// ExpireOverdueQuotes flips every quote whose "valid until" date (DueDate)
// has passed and whose status hasn't reached a terminal outcome yet to
// "expired", across every tenant (no per-request scope). Meant to run
// periodically (see main.go's quote expiry ticker).
//
// One set-based UPDATE: the database filters, so the sweep costs one round
// trip regardless of how many quotes exist (it used to load every quote of
// every tenant and update the overdue ones one by one). The rule: a quote
// with no due_date never expires; only draft/confirmed/sent are "in flight" —
// accepted/declined/expired are terminal and never touched again.
func ExpireOverdueQuotes(ctx context.Context, db orm.Executor) error {
	if _, err := db.Exec(ctx, `
		UPDATE quote SET status = 'expired', updated_at = now()
		WHERE deleted_at IS NULL
		  AND status IN ('draft', 'confirmed', 'sent')
		  AND due_date < now()`); err != nil {
		return fmt.Errorf("sale: expire overdue quotes: %w", err)
	}
	return nil
}
