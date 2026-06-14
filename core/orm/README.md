# ORM + HTTP API

A lightweight, type-safe ORM for PostgreSQL built on [pgx v5](https://github.com/jackc/pgx),
with a schema-driven HTTP API layer on top of [Echo](https://echo.labstack.com/).

**Core idea:** define a Go struct → get a full REST API with zero boilerplate.

Struct tags drive everything — reflection runs once at startup, never per query.

---

## Table of contents

1. [Getting started (5 minutes)](#getting-started-5-minutes)
2. [Defining models](#defining-models)
3. [Part 1 — Typed ORM](#part-1--typed-orm)
4. [Part 2 — HTTP API server](#part-2--http-api-server)
5. [api.yaml — per-table overrides](#apiyaml--per-table-overrides)
6. [HTTP reference](#http-reference)
7. [Running tests](#running-tests)
8. [Package layout](#package-layout)

---

## Getting started (5 minutes)

### 1. Define a model

```go
// internal/models/product.go
package models

import "core/orm/model"

type Product struct {
    model.BaseModel                   // id, created_at, updated_at, deleted_at
    Name     string  `db:"name"`
    Price    int64   `db:"price_cents"`
    Category string  `db:"category"`
}
```

That's the only file you need to write.

### 2. Register it in cmd/server/main.go

```go
package main

import (
    "context"
    "os"
    "os/signal"
    "syscall"

    "core/orm"
    ormserver "core/orm/server"
    "core/internal/models"

    "go.uber.org/zap"
)

func main() {
    logger, _ := zap.NewProduction()

    // Register your structs — one line per table.
    orm.Register[models.Product]()

    // Open the database.
    app, err := orm.New(orm.Config{DSN: os.Getenv("DATABASE_URL")}, logger)
    if err != nil { logger.Fatal("db", zap.Error(err)) }
    defer app.Close()

    // Build and start the server.
    srv := ormserver.New(app, ormserver.Config{Addr: ":8080"})
    srv.RegisterRoutes(ormserver.BuildHandlers(app))

    ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer cancel()
    srv.Start(ctx)
}
```

### 3. Start the server

```bash
DATABASE_URL="postgres://postgres:postgres@localhost:5432/erp" \
    go run ./cmd/server
```

### 4. Use the API

```bash
# Create a product
curl -X POST http://localhost:8080/api/v1/products \
     -H "Content-Type: application/json" \
     -d '{"name":"Widget","price_cents":999,"category":"tools"}'

# List with pagination
curl "http://localhost:8080/api/v1/products?page=1&page_size=20"

# Get by ID
curl http://localhost:8080/api/v1/products/<uuid>

# Update
curl -X PUT http://localhost:8080/api/v1/products/<uuid> \
     -H "Content-Type: application/json" \
     -d '{"price_cents":1299}'

# Soft-delete (available because Product embeds BaseModel with DeletedAt)
curl -X DELETE http://localhost:8080/api/v1/products/<uuid>

# Restore a soft-deleted product
curl -X POST http://localhost:8080/api/v1/products/<uuid>/restore
```

> **Adding a new table:** define a struct, call `orm.Register[T]()`, restart. No new files, no new handlers, no SQL.

---

## Defining models

### BaseModel

Every entity that should have UUID primary key, timestamps, and soft-delete must embed `model.BaseModel`:

```go
import "core/orm/model"

type Invoice struct {
    model.BaseModel                        // id, created_at, updated_at, deleted_at
    CustomerID  uuid.UUID `db:"customer_id"`
    AmountCents int64     `db:"amount_cents"`
    Status      string    `db:"status"`
    Note        string    `db:"-"`         // excluded from all queries
}
```

| Field       | Column       | Behaviour                              |
|-------------|--------------|----------------------------------------|
| `ID`        | `id`         | UUID primary key, auto-generated       |
| `CreatedAt` | `created_at` | Set on INSERT                          |
| `UpdatedAt` | `updated_at` | Set on INSERT and UPDATE               |
| `DeletedAt` | `deleted_at` | `nil` = active; non-nil = soft-deleted |

### Struct tags

```
db:"column_name"              — explicit column name
db:"column_name,pk"           — primary key
db:"column_name,omitempty"    — skip field when zero value (UPDATE/INSERT)
db:"column_name,softdelete"   — marks the soft-delete timestamp column
db:"column_name,index"        — secondary index (btree)
db:"column_name,index=hash"   — secondary index with an explicit method
db:"-"                        — exclude from all queries
```

If no `db:` tag is present, the column name defaults to `CamelCase → snake_case`.

### Indexes

Tag a column with `index` to have an index created during auto-migration. The
optional `index=<method>` selects the PostgreSQL access method — valid methods
are `btree` (default), `hash`, `gist`, `spgist`, `gin`, and `brin`. An unknown
method fails fast at startup with a metadata error.

```go
type Session struct {
    model.BaseModel
    Token  string         `db:"token,index=hash"`  // exact-match lookups
    UserID uuid.UUID      `db:"user_id,index"`     // foreign-key style lookups (btree)
    Tags   map[string]any `db:"tags,index=gin"`    // jsonb / array containment
}
```

Indexes are created as `idx_<table>_<column>` with `CREATE INDEX IF NOT EXISTS`,
so migration is idempotent — adding an `index` tag to an existing column creates
the index on the next startup without touching the data. Removing the tag does
**not** drop the index; drop it manually if no longer wanted.

The WASM/JSON migration path supports the same via an operation: set `"index": true`
(optionally `"index_type"`) on an `add_column` op, or use a standalone
`{"type": "create_index", "table": "...", "column": "...", "index_type": "gin"}`.

### Custom table name

```go
func (Invoice) TableName() string { return "billing_invoices" }
```

---

## Part 1 — Typed ORM

Use this when you need typed Go structs — service layer code, complex business logic, transactions.

### Opening a connection

```go
// Direct pool (for service code that doesn't use the API server)
db, err := orm.Open(ctx, orm.Config{
    DSN:   "postgres://postgres:postgres@localhost:5432/erp",
    Debug: true, // log all queries at Debug level
})
if err != nil { log.Fatal(err) }
defer db.Close()
db.SetLogger(orm.NewZapLogger(zapLogger))

// Via App (for code that also uses the API server)
app, err := orm.New(orm.Config{DSN: os.Getenv("DATABASE_URL")}, logger)
```

### Repository

```go
// Construct once at startup — panics on bad struct tags.
orders := orm.MustRepo[Order](db)   // or orm.MustRepo[Order](app.DB)

// Typed variant that returns an error instead.
orders, err := orm.Repo[Order](db)
```

#### Read

```go
order, err  := orders.FindByID(ctx, id)          // soft-deleted rows excluded
order, err  := orders.FindOne(ctx, orm.Cond("status = $1", "open"))
all, err    := orders.FindAll(ctx)
filtered, _ := orders.FindAll(ctx,
    orm.Cond("status = $1", "open"),
    orm.Cond("total_cents > $1", 10000),
)
n, err      := orders.Count(ctx, orm.Cond("status = $1", "open"))
withDel, _  := orders.FindAllWithDeleted(ctx)    // includes soft-deleted rows
```

#### Write

```go
created, err := orders.Create(ctx, order)         // INSERT … RETURNING *
updated, err := orders.Update(ctx, order, id)     // UPDATE … WHERE id=$1 RETURNING *
n, err       := orders.Delete(ctx, id)            // soft if DeletedAt present, hard otherwise
n, err       := orders.HardDelete(ctx, id)        // always hard DELETE
err          := orders.Restore(ctx, id)           // clear deleted_at
created, err := orders.CreateBatch(ctx, []Order{o1, o2, o3}) // single round-trip
```

#### Drop to builders

```go
rows, err := orders.Query().
    Join("JOIN customers c ON c.id = orders.customer_id").
    Where(orm.Cond("c.region = $1", "EU")).
    OrderBy("orders.created_at DESC").
    Limit(50).
    All(ctx, db)
```

### Transactions

```go
err := orm.Transact(ctx, db, func(tx *orm.Tx) error {
    if _, err := orders.WithTx(tx).Create(ctx, o); err != nil {
        return err
    }
    return lines.WithTx(tx).CreateBatch(ctx, ls)
})
```

`fn` returns `nil` → `COMMIT`. `fn` returns an error → `ROLLBACK`, original error returned.

`WithTx` returns a shallow copy scoped to the transaction — the original repository is unaffected.

### Savepoints

```go
err := orm.Transact(ctx, db, func(tx *orm.Tx) error {
    tx.Savepoint(ctx, "lines")

    if err := createLines(ctx, tx); err != nil {
        tx.RollbackTo(ctx, "lines") // undo lines only, keep outer tx alive
        return retryWithFallback(ctx, tx)
    }

    return tx.Release(ctx, "lines")
})
```

### Query builders (advanced)

Use builders directly when the repository layer isn't expressive enough.

```go
// SELECT with GROUP BY / HAVING
rows, err := orm.Select[Order](repo.Meta()).
    Columns("DATE_TRUNC('month', created_at) AS month", "SUM(total_cents) AS revenue").
    GroupBy("DATE_TRUNC('month', created_at)").
    Having(orm.Cond("SUM(total_cents) > $1", 100000)).
    OrderBy("month DESC").
    All(ctx, db)

// INSERT with upsert
result, err := query.Insert[Order](repo.Meta(), order).
    OnConflict("id").DoUpdate("status = EXCLUDED.status, updated_at = now()").
    Returning("*").
    One(ctx, db)

// UPDATE specific columns
n, err := query.Update[Order](repo.Meta()).
    Set("status", "shipped").
    Set("updated_at", time.Now()).
    Where(query.NewCondition("id = $1", id)).
    Exec(ctx, db)

// DELETE with RETURNING for audit
deleted, err := query.Delete[Order](repo.Meta()).
    Where(query.NewCondition("status = $1", "cancelled")).
    Returning("id", "customer_id").
    All(ctx, db)

// Inspect SQL without executing
sql, args := builder.ToSQL()
```

`$N` placeholders rebase automatically — always start at `$1` per condition. UPDATE and DELETE without a WHERE clause are rejected at `ToSQL()` time.

---

## Part 2 — HTTP API server

Use this when you want auto-generated REST routes. The API is driven entirely by the ORM's metadata — no per-table handler files, no hardcoded SQL, no field lists.

### How it works

```
Go struct  →  orm.Register[T]()  →  server.BuildHandlers(app)  →  mounted routes
```

For each registered struct, the server mounts:

| Method   | Path                             | Action               |
|----------|----------------------------------|----------------------|
| `GET`    | `/api/v1/{table}`                | List (paginated)     |
| `GET`    | `/api/v1/{table}/:id`            | Get by UUID          |
| `POST`   | `/api/v1/{table}`                | Create               |
| `PUT`    | `/api/v1/{table}/:id`            | Update               |
| `DELETE` | `/api/v1/{table}/:id`            | Delete (soft or hard)|
| `POST`   | `/api/v1/{table}/:id/restore`    | Restore soft-deleted |

`DELETE` and `POST …/restore` are only mounted when the struct embeds `BaseModel` (has `DeletedAt *time.Time`).

### Tutorial: exposing a new table

**Step 1 — Define the struct** (same as the ORM model, nothing extra needed):

```go
// modules/inventory/internal/stock.go
package inventory

import "core/orm/model"

type StockItem struct {
    model.BaseModel
    SKU      string `db:"sku"`
    Quantity int    `db:"quantity"`
    Location string `db:"location"`
}
```

**Step 2 — Register in main.go**:

```go
// cmd/server/main.go
orm.Register[inventory.StockItem]()
```

**Step 3 — Restart**. Routes are live:

```
GET    /api/v1/stock_items
GET    /api/v1/stock_items/:id
POST   /api/v1/stock_items
PUT    /api/v1/stock_items/:id
DELETE /api/v1/stock_items/:id
POST   /api/v1/stock_items/:id/restore
```

That's it. No new files.

### Registration options

```go
orm.Register[Product](
    // Override the table name (and URL prefix) derived from the struct name.
    orm.WithTableName("products"),

    // Fields the client may never write (stripped from POST/PUT bodies).
    orm.WithReadOnlyFields("id", "created_at", "updated_at"),

    // Fields hidden from the API entirely — not in responses, not accepted on write.
    orm.WithExcludeFields("internal_cost", "supplier_margin"),
)
```

### api.yaml — bulk overrides without code changes

Create `api.yaml` in the working directory (next to the binary) to configure tables without touching Go code. Load it before registering:

```go
orm.LoadAPIConfig("api.yaml")   // call before orm.Register[T]() calls
orm.Register[Product]()
```

```yaml
# api.yaml
tables:
  products:
    read_only_fields: [id, created_at, updated_at]
    exclude_fields:   [internal_cost]
    route_prefix:     items          # /api/v1/items instead of /api/v1/products

  users:
    exclude: true                   # no routes mounted for this table
```

### Environment variables

| Variable        | Default    | Description              |
|-----------------|------------|--------------------------|
| `DATABASE_URL`  | —          | PostgreSQL DSN (required)|
| `HTTP_ADDR`     | `:8080`    | Bind address             |
| `API_CONFIG`    | `api.yaml` | Override file path       |

### Middleware stack

Every request goes through (in order):

1. **RequestID** — injects `X-Request-ID` header
2. **Logger** — zap-structured access log
3. **Recover** — catches panics, returns 500
4. **CORS** — allows all origins by default

The server speaks plain HTTP. TLS termination belongs at the reverse proxy.

---

## HTTP reference

### List

```
GET /api/v1/{table}?page=1&page_size=20
```

Query parameters:

| Param       | Default | Description              |
|-------------|---------|--------------------------|
| `page`      | `1`     | 1-based page number      |
| `page_size` | `20`    | Records per page         |

Response `200 OK`:

```json
{
  "data": [
    { "id": "…", "name": "Widget", "price_cents": 999, "created_at": "…" }
  ],
  "total":     42,
  "page":       1,
  "page_size": 20
}
```

Soft-deleted rows are always excluded from list results.

### Get by ID

```
GET /api/v1/{table}/:id
```

Response `200 OK` — the row as a JSON object.
Response `404` — row not found or soft-deleted.

### Create

```
POST /api/v1/{table}
Content-Type: application/json

{ "name": "Gadget", "price_cents": 1499 }
```

- Server auto-generates `id`, `created_at`, `updated_at`.
- Read-only fields in the body are silently ignored.
- Missing required (non-nullable, non-server-generated) fields return `422`.

Response `201 Created` — the created row including server-set fields.

### Update

```
PUT /api/v1/{table}/:id
Content-Type: application/json

{ "price_cents": 1299 }
```

- Only fields present in the body are updated. Omitted fields are unchanged.
- `updated_at` is always set to now by the server.
- Read-only fields in the body are silently ignored.

Response `200 OK` — the updated row.
Response `404` — row not found or already soft-deleted.

### Delete

```
DELETE /api/v1/{table}/:id
```

- **Soft delete** (struct has `DeletedAt *time.Time`): sets `deleted_at = now()`. Row disappears from list/get but is recoverable via restore.
- **Hard delete** (no `DeletedAt` field): issues `DELETE FROM`. Permanent.

Response `204 No Content`.
Response `404` — row not found (or already deleted).

### Restore

```
POST /api/v1/{table}/:id/restore
```

Only available on soft-delete tables. Clears `deleted_at`, making the row active again.

Response `200 OK` — the restored row.
Response `404` — row not found.

### Error responses

All errors use the same shape:

```json
{ "error": "not found", "code": "NOT_FOUND" }
```

| HTTP status | Code              | When                                  |
|-------------|-------------------|---------------------------------------|
| `400`       | `BAD_REQUEST`     | Malformed JSON or invalid UUID in URL |
| `404`       | `NOT_FOUND`       | Row not found or soft-deleted         |
| `422`       | `VALIDATION_ERROR`| Missing required fields               |
| `500`       | `INTERNAL_ERROR`  | Unexpected server error               |

Validation errors also include a `fields` array:

```json
{
  "error": "missing required fields: name, price_cents",
  "code":  "VALIDATION_ERROR",
  "fields": ["name", "price_cents"]
}
```

---

## Running tests

Unit tests (no database required):

```bash
make run-back-tests BACKTESTPATH=./orm/...
```

Single test:

```bash
make run-back-tests BACKTESTPATH=./orm/... ARGS="-run TestService_Create"
```

Integration tests (require a running Postgres, set `TEST_DSN`):

```bash
TEST_DSN="postgres://postgres:postgres@localhost:5432/erp" \
    go test -tags integration ./orm/...
```

---

## Package layout

```
orm/
├── orm.go                    — public facade (type aliases + top-level functions)
├── app.go                    — App{DB, Logger, Config}, New(), Close()
├── register.go               — Register[T], AutoScan, LoadAPIConfig, option constructors
│
├── server/                   — HTTP API server (public — importable by cmd/server)
│   ├── server.go             — Server, New(), RegisterRoutes(), Start()
│   └── routes.go             — BuildHandlers() — wires registry → crud → handler
│
├── model/
│   ├── base.go               — BaseModel (UUID PK, timestamps, soft-delete)
│   └── entity.go             — Entity type constraint
│
├── query/
│   ├── condition.go          — Condition, NewCondition
│   ├── select.go             — SelectBuilder[T]
│   ├── insert.go             — InsertBuilder[T]
│   ├── update.go             — UpdateBuilder[T]
│   └── delete.go             — DeleteBuilder[T]
│
├── repo/
│   └── repository.go         — Repository[T] (typed CRUD)
│
├── pool/
│   ├── config/config.go      — Config, Validate, ApplyDefaults
│   ├── db/db.go              — DB (pgxpool + logging + transactions)
│   ├── tx/tx.go              — Tx (transaction executor + savepoints)
│   └── executor/executor.go  — Executor interface
│
├── log/
│   └── logger.go             — Logger interface, ZapLogger, NoopLogger
│
└── internal/                 — not importable outside core/orm
    ├── cache/
    │   ├── cache.go          — MetadataCache (sync.Map, built once per type)
    │   └── meta.go           — StructMeta, FieldMeta
    ├── scan/
    │   └── scan.go           — Rows[T] (name-based column mapping)
    ├── registry/
    │   └── registry.go       — TableMeta, Register[T], api.yaml loading
    ├── crud/
    │   ├── repository.go     — generic map-based repo (uses query builders)
    │   ├── service.go        — injects id/timestamps, guards restore
    │   └── dto.go            — ValidateRequest, BuildResponse, PaginatedResponse
    └── handler/
        └── generic_handler.go — Echo handler for any registered table
```

### Import rules

- **ERP / module code** imports only `core/orm` — never sub-packages.
- **cmd/server** imports `core/orm` (for `Register[T]`, `New`) and `core/orm/server` (for `New`, `BuildHandlers`, `Start`).
- **No layer above `crud/repository.go`** imports `pgx` directly.
- **No layer above `handler/`** imports `echo` directly.
