package db

import (
	"context"
	"core/orm/log"
	"core/orm/pool/config"
	"core/orm/pool/tx"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB is the ORM's primary handle. It wraps a pgxpool.Pool and adds:
//   - structured logging on every query (SQL, args, duration, error)
//   - a Transaction helper that owns the commit/rollback lifecycle
//
// DB is safe for concurrent use. Never copy after first use.
type DB struct {
	pool   *pgxpool.Pool
	logger log.Logger
	config config.Config
}

// Open validates cfg, applies defaults, connects the pgxpool, and returns
// a ready *DB. The pool is pinged to verify connectivity before returning.
func Open(ctx context.Context, cfg config.Config) (*DB, error) {
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("orm: invalid config: %w", err)
	}

	poolCfg, err := pgxpool.ParseConfig(cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("orm: parse DSN: %w", err)
	}

	poolCfg.MaxConns = cfg.MaxConns
	poolCfg.MinConns = cfg.MinConns

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("orm: open pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("orm: ping: %w", err)
	}

	return &DB{pool: pool, logger: log.NoopLogger{}, config: cfg}, nil
}

// SetLogger replaces the logger. Call before any queries.
// The zero-value logger is NoopLogger — no logs are emitted unless you set one.
func (db *DB) SetLogger(l log.Logger) {
	db.logger = l
}

// Close shuts down the connection pool. Call on application shutdown.
func (db *DB) Close() {
	db.pool.Close()
}

// Pool exposes the underlying pgxpool for advanced use cases (COPY, LISTEN…).
func (db *DB) Pool() *pgxpool.Pool {
	return db.pool
}

// ── Executor implementation ───────────────────────────────────────────────────

// Query executes a SQL query that returns rows.
// Logs the query, duration, and any error via the configured Logger.
func (db *DB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	start := time.Now()
	rows, err := db.pool.Query(ctx, sql, args...)
	db.log(ctx, sql, args, time.Since(start), err)
	return rows, err
}

// QueryRow executes a SQL query expected to return at most one row.
// The error (if any) is deferred to pgx.Row.Scan — logging happens there.
// We record the start time and log on the first Scan call via a wrapped row.
func (db *DB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	start := time.Now()
	row := db.pool.QueryRow(ctx, sql, args...)
	return &loggedRow{row: row, db: db, ctx: ctx, sql: sql, args: args, start: start}
}

// Exec executes a SQL statement that returns no rows (INSERT, UPDATE, DELETE).
func (db *DB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	start := time.Now()
	tag, err := db.pool.Exec(ctx, sql, args...)
	db.log(ctx, sql, args, time.Since(start), err)
	return tag, err
}

// ── Transaction ───────────────────────────────────────────────────────────────

// Transaction runs fn inside a PostgreSQL transaction.
//
//   - If fn returns nil  → COMMIT
//   - If fn returns err  → ROLLBACK, original error is returned
//   - If COMMIT fails    → ROLLBACK is attempted, commit error is returned
//
// All queries inside fn should use the *Tx argument, not the outer *DB,
// to ensure they participate in the same transaction.
func (db *DB) Transaction(ctx context.Context, fn func(*tx.Tx) error) error {
	pgxTx, err := db.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("orm: begin transaction: %w", err)
	}

	tx := &tx.Tx{Tx: pgxTx, Logger: db.logger, Config: db.config}

	if err := fn(tx); err != nil {
		// Best-effort rollback — log if it also fails but return the original error.
		if rbErr := pgxTx.Rollback(ctx); rbErr != nil {
			db.log(ctx, "ROLLBACK", nil, 0, rbErr)
		}
		return err
	}

	if err := pgxTx.Commit(ctx); err != nil {
		_ = pgxTx.Rollback(ctx)
		return fmt.Errorf("orm: commit: %w", err)
	}

	return nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func (db *DB) log(ctx context.Context, sql string, args []any, d time.Duration, err error) {
	if !db.config.Debug && err == nil {
		return
	}
	db.logger.Log(ctx, log.LogEntry{SQL: sql, Args: args, Duration: d, Err: err})
}

// loggedRow defers logging until Scan is called, capturing the round-trip time.
type loggedRow struct {
	row   pgx.Row
	db    *DB
	ctx   context.Context
	sql   string
	args  []any
	start time.Time
}

func (r *loggedRow) Scan(dest ...any) error {
	err := r.row.Scan(dest...)
	r.db.log(r.ctx, r.sql, r.args, time.Since(r.start), err)
	return err
}
