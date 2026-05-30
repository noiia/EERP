# ORM

A lightweight, type-safe ORM for PostgreSQL built on top of [pgx v5](https://github.com/jackc/pgx).

Struct tags drive everything — reflection runs once at startup, never per query.

---

## Quick start

```go
import "core/orm"

// 1. Open the connection pool once at startup.
db, err := orm.Open(ctx, orm.Config{
    DSN:   "postgres://postgres:postgres@localhost:5432/erp",
    Debug: true,
})
if err != nil { log.Fatal(err) }
defer db.Close()

// 2. Attach a logger (optional — defaults to NoopLogger).
db.SetLogger(orm.NewZapLogger(zapLogger))

// 3. Define an entity.
type Order struct {
    model.BaseModel
    Status     string `db:"status"`
    TotalCents int64  `db:"total_cents"`
}

// 4. Create a typed repository — zero reflection after this line.
orders := orm.MustRepo[Order](db)

// 5. Standard CRUD.
order, err   := orders.FindByID(ctx, id)
one, err     := orders.FindOne(ctx, orm.Cond("status = $1", "open"))
all, err     := orders.FindAll(ctx)
n, err       := orders.Count(ctx, orm.Cond("status = $1", "open"))
created, err := orders.Create(ctx, newOrder)
updated, err := orders.Update(ctx, order, id)
rows, err    := orders.Delete(ctx, id)   // soft if DeletedAt present, hard otherwise

// 6. Complex queries via builders.
results, err := orders.Query().
    Join("JOIN customers c ON c.id = orders.customer_id").
    Where(orm.Cond("c.region = $1", "EU")).
    OrderBy("orders.created_at DESC").
    Limit(50).
    All(ctx, db)

// 7. Wrap mutations in a transaction.
err = orm.Transact(ctx, db, func(tx *orm.Tx) error {
    if _, err := orders.WithTx(tx).Create(ctx, newOrder); err != nil {
        return err
    }
    return lines.WithTx(tx).CreateBatch(ctx, newLines)
})
```

---

## Model definition

Every entity must embed `model.BaseModel`:

```go
type Invoice struct {
    model.BaseModel                        // id, created_at, updated_at, deleted_at
    CustomerID  uuid.UUID `db:"customer_id"`
    AmountCents int64     `db:"amount_cents"`
    Status      string    `db:"status,omitempty"` // skip on zero value
    Note        string    `db:"-"`                // excluded from all queries
}
```

`BaseModel` provides:

| Field       | Column       | Behaviour                              |
|-------------|--------------|----------------------------------------|
| `ID`        | `id`         | UUID primary key                       |
| `CreatedAt` | `created_at` | Set on INSERT                          |
| `UpdatedAt` | `updated_at` | Set on INSERT and UPDATE               |
| `DeletedAt` | `deleted_at` | `nil` = active; non-nil = soft-deleted |

### Struct tags

```
db:"column_name"              — explicit column name
db:"column_name,pk"           — primary key
db:"column_name,omitempty"    — skip field when zero value (UPDATE/INSERT)
db:"column_name,softdelete"   — marks the soft-delete timestamp column
db:"-"                        — exclude from all queries
```

If no `db:` tag is present, the column name is derived from the field name using `CamelCase → snake_case` conversion.

### Custom table name

Implement `TableName() string` to override the default (type name → snake_case):

```go
func (Invoice) TableName() string { return "billing_invoices" }
```

---

## Repository

`Repository[T]` provides standard CRUD for any entity that embeds `BaseModel`.

```go
repo := orm.MustRepo[Order](db)   // panics on bad struct tags — use at startup only
repo, err := orm.Repo[Order](db)  // returns error instead
```

### Read

```go
// By primary key (soft-deleted rows excluded automatically)
order, err := repo.FindByID(ctx, id)

// First row matching conditions
order, err := repo.FindOne(ctx, orm.Cond("email = $1", email))

// All active rows
orders, err := repo.FindAll(ctx)

// With conditions
orders, err := repo.FindAll(ctx,
    orm.Cond("status = $1", "open"),
    orm.Cond("total_cents > $1", 10000),
)

// Count matching rows
n, err := repo.Count(ctx)
n, err := repo.Count(ctx, orm.Cond("status = $1", "open"))

// Including soft-deleted rows (audit / reconciliation)
all, err := repo.FindAllWithDeleted(ctx)
```

### Write

```go
created, err := repo.Create(ctx, order)          // INSERT … RETURNING *
updated, err := repo.Update(ctx, order, id)       // UPDATE … WHERE id=$1 RETURNING *
n, err       := repo.Delete(ctx, id)              // soft or hard — auto-detected
n, err       := repo.HardDelete(ctx, id)          // DELETE always, ignores soft-delete

// Bulk insert (single round-trip)
created, err := repo.CreateBatch(ctx, []Order{o1, o2, o3})
```

### Restore a soft-deleted row

```go
err := repo.Restore(ctx, id)
```

### Drop to builders for complex queries

```go
rows, err := repo.Query().
    Where(orm.Cond("status = $1", "open")).
    OrderBy("created_at DESC").
    Limit(50).
    All(ctx, db)
```

### Transactions

```go
err := orm.Transact(ctx, db, func(tx *orm.Tx) error {
    _, err := orders.WithTx(tx).Create(ctx, o)
    if err != nil { return err }
    return lines.WithTx(tx).CreateBatch(ctx, ls)
})
```

`WithTx` returns a shallow copy of the repository scoped to the transaction — the original is unaffected.

---

## Query builders

Use builders directly when the repository layer isn't expressive enough.

### SELECT

```go
rows, err := query.Select[Order](repo.Meta()).
    Columns("id", "status").           // default: all mapped columns
    Join("JOIN customers c ON …").
    Where(query.NewCondition("c.region = $1", "EU")).
    OrderBy("created_at DESC").
    Limit(100).
    Offset(200).
    All(ctx, db)

order, err := query.Select[Order](repo.Meta()).
    Where(query.NewCondition("id = $1", id)).
    One(ctx, db)

sql, args := builder.ToSQL()           // inspect without executing
```

### COUNT

```go
// Via builder
n, err := query.Select[Order](repo.Meta()).
    Where(query.NewCondition("status = $1", "open")).
    Count(ctx, db)

// Via repository shorthand
n, err := repo.Count(ctx, orm.Cond("status = $1", "open"))
```

`Count` strips `ORDER BY`, `LIMIT`, and `OFFSET` automatically.

### GROUP BY / HAVING

```go
// Monthly revenue totals
rows, err := orm.Select[Order](repo.Meta()).
    Columns("DATE_TRUNC('month', created_at) AS month", "SUM(total_cents) AS revenue").
    GroupBy("DATE_TRUNC('month', created_at)").
    Having(orm.Cond("SUM(total_cents) > $1", 100000)).
    OrderBy("month DESC").
    All(ctx, db)

// HAVING placeholders rebase correctly after WHERE args
rows, err := query.Select[Order](meta).
    Where(query.NewCondition("status = $1", "open")).   // $1
    GroupBy("customer_id").
    Having(query.NewCondition("COUNT(*) > $1", 5)).     // rebased to $2
    All(ctx, db)
```

### INSERT

```go
// Single row with RETURNING
result, err := query.Insert[Order](repo.Meta(), order).
    Returning("*").
    One(ctx, db)

// Batch insert
results, err := query.Insert[Order](repo.Meta(), o1, o2, o3).
    Returning("id", "created_at").
    Batch(ctx, db)

// Fire-and-forget
err := query.Insert[Order](repo.Meta(), order).Exec(ctx, db)

// Upsert — DO NOTHING
err := query.Insert[Order](repo.Meta(), order).
    OnConflictDoNothing().
    Exec(ctx, db)

// Upsert — DO UPDATE
result, err := query.Insert[Order](repo.Meta(), order).
    OnConflict("id").DoUpdate("status = EXCLUDED.status, updated_at = now()").
    Returning("*").
    One(ctx, db)
```

### UPDATE

```go
// Explicit columns
n, err := query.Update[Order](repo.Meta()).
    Set("status", "shipped").
    Set("updated_at", time.Now()).
    Where(query.NewCondition("id = $1", id)).
    Exec(ctx, db)

// From a full struct (PK excluded, omitempty fields skipped)
updated, err := query.Update[Order](repo.Meta()).
    FromStruct(order).
    Where(query.NewCondition("id = $1", id)).
    Returning("*").
    One(ctx, db)
```

UPDATE without a WHERE clause is refused at `ToSQL()` time.

### DELETE

```go
n, err := query.Delete[Order](repo.Meta()).
    Where(query.NewCondition("id = $1", id)).
    Exec(ctx, db)

// With RETURNING for audit logging
deleted, err := query.Delete[Order](repo.Meta()).
    Where(query.NewCondition("status = $1", "cancelled")).
    Returning("id", "customer_id").
    All(ctx, db)
```

DELETE without a WHERE clause is refused at `ToSQL()` time.

### Conditions

```go
orm.Cond("status = $1", "open")                        // shorthand
query.NewCondition("amount BETWEEN $1 AND $2", 0, 100) // in query package

// Multiple conditions are joined by AND automatically
repo.FindAll(ctx,
    orm.Cond("status = $1", "open"),
    orm.Cond("created_at > $1", yesterday),
)
```

`$N` placeholders are rebased automatically — always start at `$1` regardless of where the condition appears in the final query.

---

## Transactions and savepoints

```go
err := orm.Transact(ctx, db, func(tx *orm.Tx) error {
    // Savepoints for partial rollback within a transaction.
    if err := tx.Savepoint(ctx, "lines"); err != nil { return err }

    if err := createLines(ctx, tx); err != nil {
        tx.RollbackTo(ctx, "lines") // undo lines only
        return retryWithFallback(ctx, tx)
    }

    return tx.Release(ctx, "lines")
})
```

`fn` returns `nil` → `COMMIT`. `fn` returns an error → `ROLLBACK`, original error returned.

---

## Logging

```go
// Zap (recommended)
db.SetLogger(orm.NewZapLogger(zapLogger))

// Custom logger
type myLogger struct{}
func (l myLogger) Log(ctx context.Context, e orm.LogEntry) {
    fmt.Printf("[%s] %s (%v)\n", e.Duration, e.SQL, e.Err)
}
db.SetLogger(myLogger{})
```

When `Config.Debug = false`, only error queries are logged. Set `Debug: true` to log all queries.

---

## Configuration

```go
orm.Config{
    DSN:               "postgres://user:pass@host:5432/db",
    MaxConns:          10,              // default: 10
    MinConns:          2,               // default: 2
    MaxConnIdleTime:   30 * time.Minute, // default
    MaxConnLifeTime:   time.Hour,        // default
    HealthCheckPeriod: time.Minute,      // default
    ConnectTimeout:    10 * time.Second, // default
    Debug:             false,
}
```

All duration and count fields default to sensible values when zero. Defaults are applied by `Open` before validation — calling `Validate()` directly never mutates the config.

---

## Package layout

```
orm/
├── orm.go                  — public facade (type aliases + top-level functions)
├── model/
│   ├── base.go             — BaseModel (UUID PK, timestamps, soft-delete)
│   └── entity.go           — Entity type constraint
├── query/
│   ├── condition.go        — Condition, NewCondition, whereClause
│   ├── select.go           — SelectBuilder[T] (Where/Join/GroupBy/Having/Count/…)
│   ├── insert.go           — InsertBuilder[T] (OnConflict/DoUpdate/…)
│   ├── update.go           — UpdateBuilder[T]
│   └── delete.go           — DeleteBuilder[T]
├── repo/
│   └── repository.go       — Repository[T] (FindOne/FindAll/Count/Create/…)
├── pool/
│   ├── config/config.go    — Config, Validate (pure), ApplyDefaults
│   ├── db/db.go            — DB (pgxpool wrapper + logging + transactions)
│   ├── tx/tx.go            — Tx (transaction executor + savepoints)
│   └── executor/executor.go — Executor interface
├── log/
│   └── logger.go           — Logger interface, ZapLogger, NoopLogger
└── internal/
    ├── cache/
    │   ├── cache.go        — MetadataCache (sync.Map, built once per type)
    │   └── meta.go         — StructMeta, FieldMeta
    └── scan/
        └── scan.go         — Rows[T] (name-based), Row[T] (positional)
```

---

## Running tests

Unit tests (no database required):
```bash
make run-back-tests BACKTESTPATH=./orm/...
```

Integration tests (require Docker):
```bash
make run-back-tests BACKTESTPATH=./orm/pool/db/...
```

Single test:
```bash
make run-back-tests BACKTESTPATH=./orm/... ARGS="-run TestFindOne"
```
