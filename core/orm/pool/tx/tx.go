package tx

import (
	"context"
	"core/orm/log"
	"core/orm/pool/config"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Tx wraps a pgx.Tx and exposes the same Executor interface as *DB.
// It is only created by DB.Transaction — never instantiated directly.
//
// Savepoint support enables nested ERP operations:
//
//	db.Transaction(ctx, func(tx *Tx) error {
//	    // create order header
//	    if err := tx.Savepoint(ctx, "lines"); err != nil { return err }
//	    // attempt to create lines
//	    if err := createLines(ctx, tx); err != nil {
//	        tx.RollbackTo(ctx, "lines")  // undo lines only
//	        return retryWithFallback(ctx, tx)
//	    }
//	    return tx.Release(ctx, "lines")
//	})
type Tx struct {
	Tx     pgx.Tx
	Logger log.Logger
	Config config.Config
}

// ── Executor implementation ───────────────────────────────────────────────────

// Query executes a SQL query within the transaction.
func (t *Tx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	start := time.Now()
	rows, err := t.Tx.Query(ctx, sql, args...)
	t.log(ctx, sql, args, time.Since(start), err)
	return rows, err
}

// QueryRow executes a single-row query within the transaction.
func (t *Tx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	start := time.Now()
	row := t.Tx.QueryRow(ctx, sql, args...)
	return &txLoggedRow{row: row, tx: t, ctx: ctx, sql: sql, args: args, start: start}
}

// Exec executes a statement within the transaction.
func (t *Tx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	start := time.Now()
	tag, err := t.Tx.Exec(ctx, sql, args...)
	t.log(ctx, sql, args, time.Since(start), err)
	return tag, err
}

// ── Savepoints ────────────────────────────────────────────────────────────────

// Savepoint creates a named savepoint within the current transaction.
// name must be a valid PostgreSQL identifier (letters, digits, underscores).
func (t *Tx) Savepoint(ctx context.Context, name string) error {
	_, err := t.Tx.Exec(ctx, fmt.Sprintf("SAVEPOINT %s", PgxSafeName(name)))
	if err != nil {
		return fmt.Errorf("orm: savepoint %q: %w", name, err)
	}
	return nil
}

// RollbackTo rolls back to the named savepoint without ending the transaction.
// Subsequent operations on the Tx remain valid.
func (t *Tx) RollbackTo(ctx context.Context, name string) error {
	_, err := t.Tx.Exec(ctx, fmt.Sprintf("ROLLBACK TO SAVEPOINT %s", PgxSafeName(name)))
	if err != nil {
		return fmt.Errorf("orm: rollback to savepoint %q: %w", name, err)
	}
	return nil
}

// Release destroys a savepoint, making it permanent within the outer transaction.
// Call this after a successful nested operation.
func (t *Tx) Release(ctx context.Context, name string) error {
	_, err := t.Tx.Exec(ctx, fmt.Sprintf("RELEASE SAVEPOINT %s", PgxSafeName(name)))
	if err != nil {
		return fmt.Errorf("orm: release savepoint %q: %w", name, err)
	}
	return nil
}

// ── Internal ──────────────────────────────────────────────────────────────────

func (t *Tx) log(ctx context.Context, sql string, args []any, d time.Duration, err error) {
	if !t.Config.Debug && err == nil {
		return
	}
	t.Logger.Log(ctx, log.LogEntry{SQL: sql, Args: args, Duration: d, Err: err})
}

// pgxSafeName strips everything that isn't a letter, digit, or underscore
// to prevent SQL injection in SAVEPOINT names.
func PgxSafeName(s string) string {
	out := make([]byte, 0, len(s))
	for _, c := range []byte(s) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '_' {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		return "sp"
	}
	return string(out)
}

// txLoggedRow mirrors loggedRow for the Tx context.
type txLoggedRow struct {
	row   pgx.Row
	tx    *Tx
	ctx   context.Context
	sql   string
	args  []any
	start time.Time
}

func (r *txLoggedRow) Scan(dest ...any) error {
	err := r.row.Scan(dest...)
	r.tx.log(r.ctx, r.sql, r.args, time.Since(r.start), err)
	return err
}
