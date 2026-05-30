package executor

import (
	"context"
	"core/orm/pool/tx"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Executor is the minimal interface shared by *DB and *Tx.
// Every builder's All / One / Exec method accepts an Executor so the
// same call site works transparently inside or outside a transaction.
//
// The three methods map 1-to-1 onto pgx primitives:
//   - Query    → returns multiple rows (SELECT)
//   - QueryRow → returns exactly one row (SELECT … LIMIT 1, INSERT … RETURNING)
//   - Exec     → returns no rows (INSERT, UPDATE, DELETE)
type Executor interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// TxBeginner is implemented by *DB to start a transaction.
// Kept separate from Executor so Tx itself does not expose Transaction(),
// preventing accidental nesting at the type level.
type TxBeginner interface {
	Executor
	Transaction(ctx context.Context, fn func(*tx.Tx) error) error
}
