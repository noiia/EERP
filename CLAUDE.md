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
- `internal/settings/` — tenant-scoped `app_settings` key/value store (kept off the generic CRUD surface) plus the dedicated handlers behind it: `GET/PUT /api/v1/me/preferences` (self-service, JWT-scoped — e.g. the user's `preferred_locale`) and `PUT /api/v1/settings/i18n` (workspace default language, key `i18n.default_locale`, permission `settings:i18n:write`)
- `internal/auth/` — authentication (login/refresh/logout, JWT, permission DSL) plus the dedicated users/roles administration endpoints (`GET|POST /api/v1/users` + `GET|PUT /api/v1/users/:id`, same shape for `/api/v1/roles`). The auth tables are excluded from the generic CRUD surface on purpose, so these tenant-pinned, field-whitelisting handlers (email for users; name/description for roles) are the only HTTP path to them; the permission middleware derives `users:users:*` / `roles:roles:*` from the routes. A POSTed user is created **locked** — its password hash comes from discarded random bytes, so no credential matches until a dedicated password/invitation flow exists. They back the frontend's Settings → Users pages.

### 2. WASM modules (`modules/`) — Rust
Each module is a Rust crate compiled to `wasm32-unknown-unknown`. A module directory must contain:
- `module.json` — module metadata (name, version, `active`, `depends`, `priority`)
- `*.wasm` — compiled binary (auto-discovered by the detector)

Modules may optionally export two WASM functions: `migrate()` returning a pointer and `migrate_len()` returning its byte length. The core reads the pointer from linear memory, deserializes the JSON `Migration` struct, and applies `add_column` operations via `ALTER TABLE`.

A module may also ship an optional `i18n/` folder (gettext `<name>.pot` template + one `<locale>.po` per language). The catalogs are consumed by the **frontend build**: the frontend's module discovery compiles them in and the UI offers them under Settings → Translations (see `core-front/CLAUDE.md`). The Go core owns only which language each user sees: the per-user `preferred_locale` on the user record and the workspace default in `app_settings` (see `internal/settings/`).

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

**Path resolution:** relative path fields (`module_root`, `api_config_path`) are anchored to the **config file's directory**, not the process CWD (`main.go` resolves them right after decoding; absolute paths pass through untouched). This keeps a single committed config portable — the app (run from `core/cmd/app`), tests (run from `core`), and the frontend build (run from `core-front`) all resolve `core/modules` to the same place. Prefer repo-relative paths in the committed config so it is relocatable across machines.

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

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->