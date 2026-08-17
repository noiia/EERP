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
	pgxTx  pgx.Tx
	logger log.Logger
	cfg    config.Config
}

// New wraps pgxTx in a Tx with the provided logger and config.
// Only DB.Transaction should call this.
func New(pgxTx pgx.Tx, logger log.Logger, cfg config.Config) *Tx {
	return &Tx{pgxTx: pgxTx, logger: logger, cfg: cfg}
}

// ── Executor implementation ───────────────────────────────────────────────────

// Query executes a SQL query within the transaction.
func (t *Tx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	caller := log.Caller()
	start := time.Now()
	rows, err := t.pgxTx.Query(ctx, sql, args...)
	t.log(ctx, sql, args, time.Since(start), err, caller)
	return rows, err
}

// QueryRow executes a single-row query within the transaction.
func (t *Tx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	caller := log.Caller()
	start := time.Now()
	row := t.pgxTx.QueryRow(ctx, sql, args...)
	return &txLoggedRow{row: row, tx: t, ctx: ctx, sql: sql, args: args, start: start, caller: caller}
}

// Exec executes a statement within the transaction.
func (t *Tx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	caller := log.Caller()
	start := time.Now()
	tag, err := t.pgxTx.Exec(ctx, sql, args...)
	t.log(ctx, sql, args, time.Since(start), err, caller)
	return tag, err
}

// ── Savepoints ────────────────────────────────────────────────────────────────

// Savepoint creates a named savepoint within the current transaction.
// name must be a valid PostgreSQL identifier (letters, digits, underscores).
func (t *Tx) Savepoint(ctx context.Context, name string) error {
	_, err := t.pgxTx.Exec(ctx, fmt.Sprintf("SAVEPOINT %s", PgxSafeName(name)))
	if err != nil {
		return fmt.Errorf("orm: savepoint %q: %v", name, err)
	}
	return nil
}

// RollbackTo rolls back to the named savepoint without ending the transaction.
// Subsequent operations on the Tx remain valid.
func (t *Tx) RollbackTo(ctx context.Context, name string) error {
	_, err := t.pgxTx.Exec(ctx, fmt.Sprintf("ROLLBACK TO SAVEPOINT %s", PgxSafeName(name)))
	if err != nil {
		return fmt.Errorf("orm: rollback to savepoint %q: %v", name, err)
	}
	return nil
}

// Release destroys a savepoint, making it permanent within the outer transaction.
// Call this after a successful nested operation.
func (t *Tx) Release(ctx context.Context, name string) error {
	_, err := t.pgxTx.Exec(ctx, fmt.Sprintf("RELEASE SAVEPOINT %s", PgxSafeName(name)))
	if err != nil {
		return fmt.Errorf("orm: release savepoint %q: %v", name, err)
	}
	return nil
}

// ── Internal ──────────────────────────────────────────────────────────────────

func (t *Tx) log(ctx context.Context, sql string, args []any, d time.Duration, err error, caller string) {
	if !t.cfg.Debug && err == nil {
		return
	}
	t.logger.Log(ctx, log.LogEntry{SQL: sql, Args: args, Duration: d, Err: err, Caller: caller})
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
		out = []byte("sp")
	}

	return `"` + string(out) + `"`
}

// txLoggedRow mirrors loggedRow for the Tx context.
type txLoggedRow struct {
	row    pgx.Row
	tx     *Tx
	ctx    context.Context
	sql    string
	args   []any
	start  time.Time
	caller string
}

func (r *txLoggedRow) Scan(dest ...any) error {
	err := r.row.Scan(dest...)
	r.tx.log(r.ctx, r.sql, r.args, time.Since(r.start), err, r.caller)
	return err
}
