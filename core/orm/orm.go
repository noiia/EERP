// Package orm is the top-level entry point for the ERP ORM.
//
// A typical ERP service only needs to import this one package:
//
//	import "core/orm"
//
// # Quick start
//
//	// 1. Open the connection pool once at startup.
//	db, err := orm.Open(ctx, orm.Config{
//	    DSN:   os.Getenv("DATABASE_URL"),
//	    Debug: true,
//	})
//	if err != nil { log.Fatal(err) }
//	defer db.Close()
//
//	// 2. Attach a zap logger (optional — defaults to NoopLogger).
//	db.SetLogger(orm.NewZapLogger(zapLogger))
//
//	// 3. Create typed repositories — zero reflection after this line.
//	orders := orm.MustRepo[Order](db)
//
//	// 4. Standard CRUD.
//	order, err  := orders.FindByID(ctx, id)
//	created,err := orders.Create(ctx, newOrder)
//	updated,err := orders.Update(ctx, order, id)
//	n, err      := orders.Delete(ctx, id)   // soft or hard — auto-detected
//
//	// 5. Drop to builders for complex queries.
//	results, err := query.Select[Order](orders.Meta()).
//	    Join("JOIN customers c ON c.id = orders.customer_id").
//	    Where(orm.Cond("c.region = $1", "EU")).
//	    OrderBy("orders.created_at DESC").
//	    Limit(50).
//	    All(ctx, db)
//
//	// 6. Wrap mutations in a transaction.
//	err = orm.Transact(ctx, db, func(tx *orm.Tx) error {
//	    if _, err := orders.WithTx(tx).Create(ctx, newOrder); err != nil {
//	        return err
//	    }
//	    return lines.WithTx(tx).CreateBatch(ctx, newLines)
//	})
package orm

import (
	"context"

	"core/orm/log"
	"core/orm/model"
	"core/orm/pool/config"
	"core/orm/pool/db"
	"core/orm/pool/executor"
	"core/orm/pool/tx"
	"core/orm/query"
	"core/orm/repo"
)

// ── Type aliases — ERP code never imports sub-packages directly ───────────────

// DB is the primary connection handle.
// Wraps pgxpool with structured logging and transaction support.
// Safe for concurrent use. Never copy after first use.
type DB = db.DB

// Tx is a transaction-scoped executor returned by DB.Transaction / Transact.
type Tx = tx.Tx

// Config holds the parameters passed to Open.
type Config = config.Config

// Logger is the interface the ORM uses for query observability.
// Use NewZapLogger or implement your own.
type Logger = log.Logger

// LogEntry is the structured payload emitted on every query execution.
type LogEntry = log.LogEntry

// Executor is the interface shared by *DB and *Tx.
// Accept it in your own helpers so they work inside and outside transactions.
type Executor = executor.Executor

// ── Connection ────────────────────────────────────────────────────────────────

// Open validates cfg, opens the pgxpool, pings PostgreSQL, and returns a
// ready *DB. The pool is closed with db.Close() on shutdown.
//
//	db, err := orm.Open(ctx, orm.Config{DSN: os.Getenv("DATABASE_URL")})
var Open = db.Open

// ── Logging ───────────────────────────────────────────────────────────────────

// NewZapLogger wraps a *zap.Logger to satisfy orm.Logger.
// Successful queries are logged at Debug level; errors at Error level.
var NewZapLogger = log.NewZapLogger

// NewNoopLogger returns a Logger that silently discards all entries.
// This is the DB default — call db.SetLogger to replace it.
func NewNoopLogger() log.Logger { return log.NoopLogger{} }

// ── Repository ────────────────────────────────────────────────────────────────

// Repo constructs a typed Repository[T] bound to the given executor.
// Returns an error if T's struct tags cannot be resolved by the metadata cache.
//
// Prefer MustRepo at application startup where a panic is acceptable.
func Repo[T model.Entity](db executor.Executor) (*repo.Repository[T], error) {
	return repo.New[T](db)
}

// MustRepo constructs a typed Repository[T], panicking on misconfiguration.
// Safe to call in main() / dependency-injection setup. Never call inside a
// request handler — the panic will not be recovered gracefully.
func MustRepo[T model.Entity](db executor.Executor) *repo.Repository[T] {
	return repo.MustNew[T](db)
}

// ── Condition shorthand ───────────────────────────────────────────────────────

// Cond is a shorthand for query.NewCondition.
// Lets ERP code stay readable without importing the query sub-package.
//
//	orders.FindAll(ctx, orm.Cond("status = $1", "open"))
func Cond(sql string, args ...any) query.Condition {
	return query.NewCondition(sql, args...)
}

// ── Transaction ───────────────────────────────────────────────────────────────

// Transact runs fn inside a PostgreSQL transaction on db.
//   - fn returns nil  → COMMIT
//   - fn returns err  → ROLLBACK, original error returned
//
// Use WithTx on repositories to scope them to the transaction:
//
//	err := orm.Transact(ctx, db, func(tx *orm.Tx) error {
//	    if _, err := orders.WithTx(tx).Create(ctx, o); err != nil {
//	        return err
//	    }
//	    return invoices.WithTx(tx).Create(ctx, inv)
//	})
func Transact(ctx context.Context, db *db.DB, fn func(*tx.Tx) error) error {
	return db.Transaction(ctx, fn)
}
