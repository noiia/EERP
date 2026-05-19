# ORM

A thin, type-safe query layer built on [pgx v5](https://github.com/jackc/pgx). PostgreSQL only.

## Quick start

```go
// 1. Open a connection pool
db, err := orm.Open(ctx, orm.Config{DSN: "postgres://..."})

// 2. Define an entity
type Order struct {
    model.BaseModel          // id (pk), created_at, updated_at, deleted_at
    Status     string    `db:"status"`
    CustomerID uuid.UUID `db:"customer_id"`
}

// 3. Build a repository
orders, err := orm.Repo[Order](db)

// 4. CRUD
order,  err := orders.Create(ctx, Order{Status: "open", CustomerID: cid})
order,  err := orders.FindByID(ctx, id)
order,  err := orders.Update(ctx, Order{Status: "shipped"}, id)
n,      err := orders.Delete(ctx, id)        // soft-delete when DeletedAt is present
n,      err := orders.HardDelete(ctx, id)    // permanent regardless
err         = orders.Restore(ctx, id)
results,err := orders.FindAll(ctx, orm.Cond("status = $1", "open"))
```

## Struct tags

| Tag | Effect |
|---|---|
| `db:"col"` | Map to column `col` |
| `db:"col,pk"` | UUID primary key — excluded from INSERT and UPDATE SET |
| `db:"col,immutable"` | Excluded from UPDATE SET (`created_at`) |
| `db:"col,softdelete"` | `*time.Time`; nil = active, non-nil = deleted |
| `db:"col,omitempty"` | Skip field in UPDATE when zero |
| `db:"-"` | Ignore field entirely |

Every entity should embed `model.BaseModel` which provides `id`, `created_at`, `updated_at`, and `deleted_at` with the correct tags pre-applied.

## Repository methods

| Method | Description |
|---|---|
| `Create(ctx, entity)` | INSERT + RETURNING * |
| `CreateBatch(ctx, []entity)` | Multi-row INSERT in one round-trip |
| `FindByID(ctx, id)` | SELECT with soft-delete guard |
| `FindAll(ctx, conds...)` | SELECT all active rows, optional conditions |
| `FindAllWithDeleted(ctx, conds...)` | SELECT including soft-deleted rows |
| `Query()` | Returns a `SelectBuilder` for custom queries |
| `Update(ctx, entity, id)` | UPDATE writable fields + set `updated_at` |
| `Delete(ctx, id)` | Soft-delete if `deleted_at` present, hard DELETE otherwise |
| `HardDelete(ctx, id)` | Permanent DELETE regardless of soft-delete config |
| `DeleteWhere(ctx, conds...)` | Bulk soft or hard delete by conditions |
| `Restore(ctx, id)` | Clear `deleted_at` |
| `WithTx(tx)` | Scope repository to an existing transaction |

## Query builders

Use builders when the repository methods are not enough (JOINs, complex WHERE, custom RETURNING).

```go
// SELECT with JOIN
rows, err := query.Select[Order](orders.Meta()).
    Join("JOIN customers c ON c.id = orders.customer_id").
    Where(orm.Cond("c.region = $1", "EU")).
    Where(orm.Cond("orders.status = $1", "open")).
    OrderBy("orders.created_at DESC").
    Limit(50).
    All(ctx, db)

// INSERT
order, err := query.Insert[Order](meta, newOrder).
    Returning("*").
    One(ctx, db)

// UPDATE with RETURNING
updated, err := query.Update[Order](meta).
    Set("status", "shipped").
    Where(orm.Cond("id = $1", id)).
    Returning("*").
    One(ctx, db)

// DELETE with RETURNING
deleted, err := query.Delete[Order](meta).
    Where(orm.Cond("id = $1", id)).
    Returning("*").
    One(ctx, db)

// UPSERT
result, err := query.Upsert[SKU](meta, sku).
    OnConflict("sku_code").
    DoUpdateSet("stock", "price").   // partial update — only named cols
    Returning("*").
    One(ctx, db)
```

All builders are **immutable** — every method returns a new copy. Safe to branch:

```go
base := query.Select[Order](meta).Where(orm.Cond("deleted_at IS NULL"))
eu   := base.Where(orm.Cond("region = $1", "EU")).Limit(100)
us   := base.Where(orm.Cond("region = $1", "US")).Limit(100)
// base is unchanged
```

`$N` placeholders are always rebased automatically — write `$1` in every condition.

## Upsert

```go
// Update all writable columns on conflict
query.Upsert[T](meta, rows...).OnConflict("col").DoUpdate()

// Update only named columns (keeps other columns unchanged)
query.Upsert[T](meta, rows...).OnConflict("col").DoUpdateSet("stock", "updated_at")

// Ignore conflicts entirely
query.Upsert[T](meta, rows...).OnConflict("col").DoNothing()
```

`OnConflict()` is required — `ToSQL()` returns an error if it is not called.

## Transactions

```go
err := orm.Transact(ctx, db, func(tx *orm.Tx) error {
    orders, _ := orm.Repo[Order](tx)
    lines,  _ := orm.Repo[Line](tx)

    o, err := orders.Create(ctx, Order{...})
    if err != nil {
        return err  // automatic rollback
    }
    _, err = lines.Create(ctx, Line{OrderID: o.ID, ...})
    return err
})
```

Use `repo.WithTx(tx)` to scope an already-constructed repository to a transaction:

```go
err := orm.Transact(ctx, db, func(tx *orm.Tx) error {
    _, err := orders.WithTx(tx).Update(ctx, updated, id)
    return err
})
```

## Irregular table names

By default the table name is derived as `plural(snake(TypeName))`. Override it by implementing `TableName() string`:

```go
type OrderLineItem struct { ... }
func (OrderLineItem) TableName() string { return "order_lines" }
```

## Layer map

```
orm.go                ← single import surface; type aliases + thin wrappers
pool/config/          ← Config struct, Validate(), connection defaults
pool/db/              ← *DB: pgxpool wrapper, Open(), Transaction()
pool/tx/              ← *Tx: transaction-scoped executor, Savepoint support
pool/executor/        ← Executor interface (Query/QueryRow/Exec)
internal/cache/       ← StructMeta + MetadataCache (built once via reflect)
internal/scan/        ← Rows[T] (name-mapped) + Row[T] (positional) + RowFromRows[T]
model/base.go         ← BaseModel (id, created_at, updated_at, deleted_at)
query/condition.go    ← Condition + $N rebasing
query/select.go       ← SelectBuilder[T]
query/insert.go       ← InsertBuilder[T]
query/update.go       ← UpdateBuilder[T]
query/delete.go       ← DeleteBuilder[T]
query/upsert.go       ← UpsertBuilder[T]
repo/repository.go    ← Repository[T]: full CRUD + soft-delete
log/                  ← Logger interface, ZapLogger, NoopLogger
```

## Running tests

```bash
# All tests (starts DB container automatically)
make run-back-tests

# Integration tests only (requires live DB)
cd core && TEST_DSN="postgres://postgres:postgres@localhost:5432/poc?sslmode=disable" \
    go test -tags=integration ./orm/...
```
