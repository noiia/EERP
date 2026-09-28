package db

import (
	"context"
	"core/orm/log"
	"core/orm/pool/config"
	"core/orm/pool/tx"
	"core/orm/qcache"
	"fmt"
	"sync"
	"sync/atomic"
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
//
// pool is an atomic.Pointer, not a plain field, so SwapPool (below) can
// repoint an already-live *DB at a different database with no downtime —
// every Repository[T]/long-lived component in the app holds a reference back
// to this SAME *DB, never a copy of the pool, so a swap here propagates
// everywhere with nothing else to rebuild (core/internal/dbmanage's live
// database switch).
type DB struct {
	pool   atomic.Pointer[pgxpool.Pool]
	logger log.Logger
	config config.Config
	// cache is the optional Redis read cache (nil = disabled). DB owns its
	// invalidation: every write it executes bumps the written table's
	// generation once committed, whoever issued it (generic CRUD, a typed
	// Repository[T], a module's raw SQL).
	cache *qcache.Cache
}

// Open applies defaults, validates cfg, connects the pgxpool, and returns
// a ready *DB. The pool is pinged to verify connectivity before returning.
func Open(ctx context.Context, cfg config.Config) (*DB, error) {
	cfg.ApplyDefaults()

	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("orm: invalid config: %w", err)
	}

	poolCfg, err := pgxpool.ParseConfig(cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("orm: parse DSN: %w", err)
	}

	poolCfg.MaxConns = cfg.MaxConns
	poolCfg.MinConns = cfg.MinConns
	poolCfg.MaxConnIdleTime = cfg.MaxConnIdleTime
	poolCfg.MaxConnLifetime = cfg.MaxConnLifeTime
	poolCfg.HealthCheckPeriod = cfg.HealthCheckPeriod
	poolCfg.ConnConfig.ConnectTimeout = cfg.ConnectTimeout

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("orm: open pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("orm: ping: %w", err)
	}

	db := &DB{logger: log.NoopLogger{}, config: cfg}
	db.pool.Store(pool)
	return db, nil
}

// SetLogger replaces the logger. Call before any queries.
// The zero-value logger is NoopLogger — no logs are emitted unless you set one.
func (db *DB) SetLogger(l log.Logger) {
	db.logger = l
}

// Close shuts down the connection pool. Call on application shutdown.
func (db *DB) Close() {
	db.pool.Load().Close()
}

// Pool exposes the underlying pgxpool for advanced use cases (COPY, LISTEN…).
func (db *DB) Pool() *pgxpool.Pool {
	return db.pool.Load()
}

// SetQueryCache enables the optional read cache (nil disables it). Call before
// serving. It invalidates the current database's entries: rows cached by an
// earlier process may predate this boot's migrations.
func (db *DB) SetQueryCache(c *qcache.Cache) {
	db.cache = c
	c.Invalidate(context.Background(), db.Name())
}

// QueryCache returns the read cache, or nil when none is configured.
func (db *DB) QueryCache() *qcache.Cache { return db.cache }

// Name is the database the live pool points at — part of every cache key, so
// several EERP databases can share one Redis.
func (db *DB) Name() string { return db.pool.Load().Config().ConnConfig.Database }

// SwapPool atomically repoints db at newPool and returns the pool that was
// live until this call — every in-flight query already holds its own
// reference to the OLD pool (pgxpool methods don't re-read db.pool mid-call),
// so nothing breaks mid-request; the caller is responsible for closing the
// returned pool once satisfied in-flight work against it has drained (e.g.
// after a short grace delay), never immediately.
func (db *DB) SwapPool(newPool *pgxpool.Pool) (old *pgxpool.Pool) {
	old = db.pool.Swap(newPool)
	// The target may be a database restored or recreated under a name whose
	// old entries still sit in Redis.
	db.cache.Invalidate(context.Background(), db.Name())
	return old
}

// ── Executor implementation ───────────────────────────────────────────────────

// Query executes a SQL query that returns rows.
// Logs the query, duration, and any error via the configured Logger.
func (db *DB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	caller := log.Caller()
	start := time.Now()
	rows, err := db.pool.Load().Query(ctx, sql, args...)
	db.log(ctx, sql, args, time.Since(start), err, caller)
	if err == nil && db.cache != nil {
		if _, write := qcache.WriteTarget(sql); write {
			// A RETURNING write completes when its rows are drained.
			return &invalidatingRows{Rows: rows, done: func() { db.invalidate(ctx, sql) }}, nil
		}
	}
	return rows, err
}

// QueryRow executes a SQL query expected to return at most one row.
// The error (if any) is deferred to pgx.Row.Scan — logging happens there.
// We record the start time and log on the first Scan call via a wrapped row.
func (db *DB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	caller := log.Caller()
	start := time.Now()
	row := db.pool.Load().QueryRow(ctx, sql, args...)
	return &loggedRow{row: row, db: db, ctx: ctx, sql: sql, args: args, start: start, caller: caller}
}

// Exec executes a SQL statement that returns no rows (INSERT, UPDATE, DELETE).
func (db *DB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	caller := log.Caller()
	start := time.Now()
	tag, err := db.pool.Load().Exec(ctx, sql, args...)
	db.log(ctx, sql, args, time.Since(start), err, caller)
	if err == nil {
		db.invalidate(ctx, sql)
	}
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
	pgxTx, err := db.pool.Load().Begin(ctx)
	if err != nil {
		return fmt.Errorf("orm: begin transaction: %w", err)
	}

	tx := tx.New(pgxTx, db.logger, db.config)

	if err := fn(tx); err != nil {
		// Best-effort rollback — log if it also fails but return the original error.
		if rbErr := pgxTx.Rollback(ctx); rbErr != nil {
			db.log(ctx, "ROLLBACK", nil, 0, rbErr, log.Caller())
		}
		return err
	}

	if err := pgxTx.Commit(ctx); err != nil {
		_ = pgxTx.Rollback(ctx)
		return fmt.Errorf("orm: commit: %w", err)
	}

	// Only now are the transaction's writes visible — bumping any earlier
	// would let a reader re-cache the pre-commit rows under the new generation.
	if tables, all := tx.Written(); all {
		db.cache.Invalidate(ctx, db.Name())
	} else if len(tables) > 0 {
		db.cache.Invalidate(ctx, db.Name(), tables...)
	}
	return nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func (db *DB) log(ctx context.Context, sql string, args []any, d time.Duration, err error, caller string) {
	if !db.config.Debug && err == nil {
		return
	}
	db.logger.Log(ctx, log.LogEntry{SQL: sql, Args: args, Duration: d, Err: err, Caller: caller})
}

// invalidate bumps the cache generation of the table sql writes, if any.
func (db *DB) invalidate(ctx context.Context, sql string) {
	if db.cache == nil {
		return
	}
	switch table, write := qcache.WriteTarget(sql); {
	case !write:
	case table == "":
		db.cache.Invalidate(ctx, db.Name())
	default:
		db.cache.Invalidate(ctx, db.Name(), table)
	}
}

// invalidatingRows runs done once, when the caller closes the rows.
type invalidatingRows struct {
	pgx.Rows
	done func()
	once sync.Once
}

func (r *invalidatingRows) Close() {
	r.Rows.Close()
	r.once.Do(r.done)
}

// Next closes (and so invalidates) on exhaustion too: pgx callers often drain
// rows without an explicit Close.
func (r *invalidatingRows) Next() bool {
	if r.Rows.Next() {
		return true
	}
	r.once.Do(r.done)
	return false
}

// loggedRow defers logging until Scan is called, capturing the round-trip time.
type loggedRow struct {
	row    pgx.Row
	db     *DB
	ctx    context.Context
	sql    string
	args   []any
	start  time.Time
	caller string
}

func (r *loggedRow) Scan(dest ...any) error {
	err := r.row.Scan(dest...)
	r.db.log(r.ctx, r.sql, r.args, time.Since(r.start), err, r.caller)
	// QueryRow carries INSERT/UPDATE ... RETURNING; the write is committed
	// once Scan returns. Bump even on error (e.g. ErrNoRows) — conservative.
	r.db.invalidate(r.ctx, r.sql)
	return err
}
