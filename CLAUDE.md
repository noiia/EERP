# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Go ERP — modular monolith. PostgreSQL only. Custom ORM (`github.com/erp/orm`, root: `core/orm/`).

## Response Rules

- No preamble, no conclusion, no restating the prompt
- Prefer diffs over full rewrites; return only changed sections
- Bullets over prose
- Explain tradeoffs only when they affect architecture, performance, or security
- Target <300 tokens unless complexity demands more

## Model Routing

**Lightweight** (default): CRUD, boilerplate, refactors, SQL gen, unit tests, API wiring, frontend, Docker, linting, CI.

**Powerful** (escalate only for): ORM internals, query planner, concurrency/race conditions, distributed design, security-sensitive code, large refactors, advanced generics, migration safety, memory optimization.

**Auto-escalate if**: 3+ failed attempts, architectural uncertainty, benchmark regression, data corruption risk, transaction/concurrent mutation, reflection/generics/meta-programming.

## Stack

| Layer | Choice |
|---|---|
| Backend | Go 1.26, `core/` (owns `go.mod`) |
| Database | PostgreSQL 18 — `docker compose up -d` (db=`poc`, user/pass=`postgres`) |
| ORM | Custom pgx v5, `core/orm/`, imported as `github.com/erp/orm` |
| Logger | `go.uber.org/zap` |
| Frontend | SvelteKit 2 + TypeScript, `core-front/` |
| Config | `eerp-config.json` passed via `-config` flag to the backend |

## Commands

```bash
# Backend
make run-back                          # go run core/cmd/app/main.go -config=eerp-config.json
make run-back-tests                    # docker compose up -d && cd core && go test ./...

# Single package / named test
cd core && go test ./orm/repo/...
cd core && go test ./orm/... -run TestRepository_FindByID

# Integration tests (needs live DB)
cd core && TEST_DSN="postgres://postgres:postgres@localhost:5432/poc?sslmode=disable" \
    go test -tags=integration ./orm/...

# Lint / format
cd core && golangci-lint run ./...
gofmt -w .

# Frontend
make run-front                         # vite dev --host 0.0.0.0
```

## ORM

### Struct tags (`db`)

| Modifier | Effect |
|---|---|
| `db:"col"` | maps to column |
| `db:"col,pk"` | UUID primary key |
| `db:"col,immutable"` | excluded from UPDATE (`created_at`) |
| `db:"col,softdelete"` | `*time.Time`; nil=active, non-nil=deleted |
| `db:"-"` | ignored |

Every entity embeds `model.BaseModel` (`id`, `created_at`, `updated_at`, `deleted_at`).

```go
type Order struct {
    model.BaseModel
    Status     string    `db:"status"`
    CustomerID uuid.UUID `db:"customer_id"`
}
```

### Layer map

```
orm.go           ← single import point; aliases all sub-packages
pool/config/     ← Config, validation, defaults
pool/db/         ← *DB (pgxpool wrapper); Open(), Transaction()
pool/executor/   ← Executor interface shared by *DB and *Tx
pool/tx/         ← *Tx (transaction-scoped executor)
internal/cache/  ← StructMeta cache (sync.Map, built once per type via reflect)
internal/scan/   ← pgx row → struct scanner using IndexPath
model/           ← BaseModel, Entity constraint
query/           ← immutable builders: Select, Insert, Update, Delete, Upsert, Condition
repo/            ← generic Repository[T]: CRUD, soft/hard delete, batch
log/             ← Logger interface, ZapLogger, NoopLogger
```

### Query builder (drop below repo layer)

```go
rows, err := query.Select[Order](repo.Meta()).
    Join("JOIN customers c ON c.id = orders.customer_id").
    Where(orm.Cond("c.region = $1", "EU")).
    OrderBy("orders.created_at DESC").
    Limit(50).
    All(ctx, db)
```

Builders are immutable — every method returns a new copy; `$N` args are rebased automatically.

## Testing

- Unit tests: database-free, mock executors
- Integration tests: `//go:build integration` + `TEST_DSN` env var
- Table-driven; minimize mocks; test observable behavior
- **Modified code → updated tests**

## Decision Heuristic

Prefer: easier to maintain → benchmark → debug → lower overhead → more explicit → PostgreSQL-efficient → safer under concurrency.
