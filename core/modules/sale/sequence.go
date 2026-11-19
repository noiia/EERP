package sale

import (
	"context"
	"fmt"
	"time"

	"core/orm"

	"github.com/google/uuid"
)

// Quote and invoice numbers are never typed: each document gets the next
// number of its kind's sequence when it is created — "Q-2026-0001",
// "INV-2026-0001" — one sequence per tenant, company (the creator's active
// company) and year, restarting at 1 each January. Numbers are taken at
// creation, so a draft deleted later leaves a gap.

const (
	sequenceQuote   = "quote"
	sequenceInvoice = "invoice"
)

// sequenceKinds maps a sequence kind to its number prefix and its table.
var sequenceKinds = map[string]struct{ prefix, table string }{
	sequenceQuote:   {"Q", "quote"},
	sequenceInvoice: {"INV", "invoice"},
}

// nextNumber takes the next number of kind's sequence for (tenant, company)
// in at's year. One atomic statement: concurrent creates never get the same
// number. A sequence's first use starts after the highest number of that
// year already in the table in the same format (any company — the rows don't
// record theirs), so numbers typed before sequences existed are never
// handed out again.
func nextNumber(ctx context.Context, ex orm.Executor, tenant, company uuid.UUID, kind string, at time.Time) (string, error) {
	k, ok := sequenceKinds[kind]
	if !ok {
		return "", fmt.Errorf("sale: unknown sequence %q", kind)
	}
	year := at.Year()
	pattern := fmt.Sprintf(`^%s-%d-(\d+)$`, k.prefix, year)
	var n int
	// #nosec G201 — the table name comes from sequenceKinds, never the caller.
	err := ex.QueryRow(ctx, fmt.Sprintf(`
		INSERT INTO sale_sequence (tenant_id, company_id, kind, year, last)
		SELECT $1, $2, $3, $4, COALESCE(MAX(substring(number from $5)::int), 0) + 1
		  FROM %s WHERE tenant_id = $1 AND number ~ $5
		ON CONFLICT (tenant_id, company_id, kind, year)
		DO UPDATE SET last = sale_sequence.last + 1
		RETURNING last`, k.table), tenant, company, kind, year, pattern).Scan(&n)
	if err != nil {
		return "", fmt.Errorf("sale: next %s number: %w", kind, err)
	}
	return formatNumber(k.prefix, year, n), nil
}

// formatNumber is "<prefix>-<year>-<n, 4 digits at least>".
func formatNumber(prefix string, year, n int) string {
	return fmt.Sprintf("%s-%d-%04d", prefix, year, n)
}
