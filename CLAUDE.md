# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start everything (Docker DB + frontend + backend)
make run

# Backend only (requires Docker DB already running)
make run-back

# Frontend only
make run-front

# Run backend tests (starts Docker DB automatically)
make run-back-tests

# Run a specific package's tests
make run-back-tests BACKTESTPATH=./orm/...

# Pass extra go test flags (e.g. verbose, run a single test)
make run-back-tests ARGS="-v -run TestMyFunc"

# Build Rust WASM modules
make build

# Full clean + rebuild + run
make rebuild-and-run
```

Lint (from `core/`):
```bash
golangci-lint run ./...
```

Format:
```bash
gofmt -w .
```

## Architecture

This is a modular ERP with three distinct layers:

### 1. Core backend (`core/`) — Go
Entry point: `core/cmd/app/main.go`. On startup it:
- Reads `eerp-config.json` (path via `-config` flag)
- Opens a PostgreSQL connection (pgx)
- Creates a Wasmtime engine/store/linker
- Calls `module.LoadModules()` which detects, orders, and loads WASM modules

Key internal packages:
- `internal/module/` — module detection (`detector.go`), loading (`load.go`), and DB migration (`migration.go`). The detector scans `module_root` dirs for `module.json` files, builds filesystem snapshots for change detection, resolves `depends` ordering via topological priority, and loads each `.wasm` binary in priority order (same-priority modules load concurrently).
- `internal/types/` — shared structs: `Config`, `Module`, `Migration`, `Operation`
- `internal/common/` — logger (zap), file utilities, JSON decoder

### 2. WASM modules (`modules/`) — Rust
Each module is a Rust crate compiled to `wasm32-unknown-unknown`. A module directory must contain:
- `module.json` — module metadata (name, version, `active`, `depends`, `priority`)
- `*.wasm` — compiled binary (auto-discovered by the detector)

Modules may optionally export two WASM functions: `migrate()` returning a pointer and `migrate_len()` returning its byte length. The core reads the pointer from linear memory, deserializes the JSON `Migration` struct, and applies `add_column` operations via `ALTER TABLE`.

### 3. Frontend (`core-front/`) — SvelteKit + TypeScript

## ORM (`core/orm/`)

A custom generic ORM on top of `pgxpool`. ERP code only imports the `core/orm` facade — never sub-packages directly.

**Model definition:**
```go
type Order struct {
    model.BaseModel          // uuid PK, created_at, updated_at, deleted_at (soft-delete)
    Status string `db:"status"`
}
```

**Usage pattern:**
```go
db, _ := orm.Open(ctx, orm.Config{DSN: "..."})
orders := orm.MustRepo[Order](db)

// CRUD
order, _ := orders.FindByID(ctx, id)
created, _ := orders.Create(ctx, newOrder)
updated, _ := orders.Update(ctx, order, id)
n, _ := orders.Delete(ctx, id)       // soft if DeletedAt present, hard otherwise

// Complex queries via builders
results, _ := query.Select[Order](orders.Meta()).
    Where(orm.Cond("status = $1", "open")).
    OrderBy("created_at DESC").
    Limit(50).
    All(ctx, db)

// Transactions
orm.Transact(ctx, db, func(tx *orm.Tx) error {
    _, err := orders.WithTx(tx).Create(ctx, o)
    return err
})
```

Struct tags use `db:"column_name"`, with optional `,pk` and `,softdelete` modifiers. Metadata is resolved once at `MustRepo` construction via `core/orm/internal/cache` — zero reflection at query time.

## Configuration

`eerp-config.json` at the repo root is the dev config. Required fields include `module_root` (array of paths), `db_*` connection settings. The backend is started with:
```bash
go run main.go -config="../../eerp-config.json"
```

The Docker Compose service (`compose.yml`) runs PostgreSQL 18 on port 5432 with user/password `postgres` and database `poc`.

## Conventions

- Commit format: `<type>(scope): <description>` — types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`
- `internal/` for business logic; `cmd/` for entry points only
- Interfaces defined at the call site, not the implementation
- Table-driven tests with subtests (`t.Run`)
- `depguard` blocks direct use of `fmt` and `log` packages (use `go.uber.org/zap` via `common.Logger`)

# Documentation Rules

Documentation is considered part of the codebase.

Whenever the architecture, public API, data model, routing, ORM behavior, module system or developer workflow changes, update the documentation in the same task.

Never leave documentation outdated.

Documentation should always explain:

- Why something exists
- What problem it solves
- How it works
- How developers should use it
- Common pitfalls

Do not simply describe the code.

Prefer architecture explanations over implementation details.

Every documentation page should be understandable by a developer discovering the project for the first time.

Whenever possible:

- Generate Mermaid diagrams.
- Link related pages.
- Include practical examples.
- Explain design decisions.

If an architectural decision changes significantly, create or update an ADR.

Documentation should be written in Markdown and compatible with MkDocs Material.

Avoid duplicate information.

Documentation must remain concise, technical and maintainable.

## Framework-first documentation

Assume this project is a reusable framework rather than a single application.

Document stable concepts instead of current implementations.

When documenting a component, focus on:

- its contract
- its public behavior
- its responsibilities
- its extension mechanisms
- its integration with the rest of the framework

Avoid documenting private implementation details unless they are essential to understanding the architecture.

Documentation should remain valid even if internal implementations evolve.