// Package query provides type-safe SQL builders for SELECT, INSERT, and UPDATE.
// Builders are pure value types — they produce (sql, args) and never touch a
// connection themselves. Execution is delegated to core.Executor so the same
// builder works identically inside and outside a transaction.
//
// Argument placeholders are PostgreSQL-style ($1, $2 …). The builders manage
// the counter internally so callers never deal with placeholder numbering.
package query

import (
	"fmt"
	"strings"
)

// Condition represents a single WHERE predicate with its bound arguments.
// The SQL fragment must use $N placeholders starting at the offset the builder
// provides — use NewCondition to construct one safely.
type Condition struct {
	sql  string // e.g. "email = $1"
	args []any
}

// NewCondition builds a Condition from a raw SQL fragment and its arguments.
// The fragment must use $1, $2 … counting from 1 — the builder will rewrite
// the placeholder numbers to fit the full query's argument list.
//
// Example:
//
//	NewCondition("status = $1 AND created_at > $2", "open", yesterday)
func NewCondition(sql string, args ...any) Condition {
	return Condition{sql: sql, args: args}
}

// rebase rewrites $1..$N in the fragment to $offset..$offset+N-1.
// This lets each condition be written independently of where it appears
// in the final query's argument list.
func (c Condition) rebase(offset int) (string, []any) {
	if len(c.args) == 0 {
		return c.sql, nil
	}
	sql := c.sql
	// Walk backwards so "$10" isn't partially rewritten before "$1".
	for i := len(c.args); i >= 1; i-- {
		old := fmt.Sprintf("$%d", i)
		new := fmt.Sprintf("$%d", offset+i-1)
		sql = strings.ReplaceAll(sql, old, new)
	}
	return sql, c.args
}

// whereClause joins conditions with AND and returns the full WHERE fragment
// and the flat args slice, starting argument numbering at startIdx.
//
// Returns ("", nil) when conditions is empty so callers can append
// the result directly without extra blank checks.
func whereClause(conditions []Condition, startIdx int) (string, []any) {
	if len(conditions) == 0 {
		return "", nil
	}

	parts := make([]string, 0, len(conditions))
	args := make([]any, 0)
	idx := startIdx

	for _, c := range conditions {
		fragment, cArgs := c.rebase(idx)
		parts = append(parts, fragment)
		args = append(args, cArgs...)
		idx += len(cArgs)
	}

	return "WHERE " + strings.Join(parts, " AND "), args
}

// placeholders returns "$1,$2,…,$n" starting at offset.
func placeholders(count, offset int) string {
	parts := make([]string, count)
	for i := range parts {
		parts[i] = fmt.Sprintf("$%d", offset+i)
	}
	return strings.Join(parts, ", ")
}
