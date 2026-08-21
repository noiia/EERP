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

# Build WASM modules (Go source, cross-compiled to WASI)
make build

# Full clean + rebuild + run
make rebuild-and-run

# Scaffold a new module (module.json/module.go + frontend views/package.json),
# wire it into core/modules/all/all.go if -t go, and pnpm install to link it
go run ./tools/eerp-init-module -p core/modules/<name> -t go   # or -t wasm
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
- Calls `module.NewRegistry(...)` (`internal/module/runtime.go`) which detects, orders, and loads every module — WASM and Go, active or not

Key internal packages:
- `internal/module/` — module detection (`detector.go`), loading (`load.go`), DB migration (`migration.go`), and the live runtime lifecycle (`runtime.go`, `oplog.go`; `docs/adr/ADR-009-live-module-lifecycle.md`). The detector scans `module_root` dirs for `module.json` files, builds filesystem snapshots for change detection, resolves `depends` ordering via topological priority. `runtime.go`'s `Registry` replaces the old one-shot boot: it loads **every** discovered module — WASM and Go, active or not — at startup (one `wasmtime.Store` per WASM module, not shared, so a later reload can drop just that module's memory), and keeps `active`/table-ownership state live in memory so `ActiveGateMiddleware` (one extra middleware on the generic CRUD route group) can 403 a deactivated module's routes per request instead of never loading them. Also backs the App Store's module-management API (`manager.go`/`handler.go`, `docs/roadmaps/app-store.md`, `docs/adr/ADR-008-module-lifecycle-via-api.md`, `docs/adr/ADR-009-live-module-lifecycle.md`): `GET /api/v1/modules` (list, generic `{data, total}` envelope, excludes the `appstore` module's own record) + `GET /api/v1/modules/:id` (both re-walking `module_root` on every call, raw `map[string]any` — not `types.Module` — so a PUT can round-trip unknown/future `module.json` keys untouched, annotated with `module_dir` for the frontend's Views table) + `PUT /api/v1/modules/:id` (flips `Registry.SetActive`'s live gate FIRST, then writes `module.json` atomically — temp file + rename — restricted to `writableModuleFields`, currently just `active`; the appstore module itself refuses `active: false`) + `POST /api/v1/modules/:id/reload` (re-instantiates a WASM module's binary with no restart; a re-validation no-op for Go-type modules, whose code is compiled into the binary and needs a rebuild+restart to actually change) + `GET /api/v1/modules/:id/logs` (every activate/deactivate/reload run's backend/DB log lines, grouped by operation). A successful `PUT`/`POST /reload` is live by the time the response returns — no `requires_restart` field anymore. Permissions `modules:modules:read`/`write` derived from the routes.
- `internal/types/` — shared structs: `Config`, `Module`, `Migration`, `Operation`
- `internal/common/` — logger (zap), file utilities, JSON decoder
- `internal/settings/` — tenant-scoped `app_settings` key/value store (kept off the generic CRUD surface) plus the dedicated handlers behind it: `GET/PUT /api/v1/me/preferences` (self-service, JWT-scoped — e.g. the user's `preferred_locale`), `PUT /api/v1/settings/i18n` (workspace default language, key `i18n.default_locale`, permission `settings:i18n:write`), `PUT /api/v1/settings/format` (workspace number format, key `format.number`, permission `settings:format:write`), `GET/PUT /api/v1/settings/views/:entity/fields` (which field, if any, is that entity's Kanban status field / Calendar date field, key `views.<entity>.fields`, permissions `settings:views:read`/`settings:views:write` — see `docs/roadmaps/list-view-modes.md` and `docs/adr/ADR-006-runtime-configurable-view-fields.md`), and `GET/PUT /api/v1/settings/views/:entity/graph` (entity's Graph mode tile layout, key `views.<entity>.graph`, same permissions — an unconfigured entity reads as an empty canvas, not a 404; the backend validates each tile's shape — id, non-negative/non-zero geometry, closed type set, no duplicate ids — but never its opaque `config`), and `GET/PUT /api/v1/settings/integrations/osm` (the workspace's OpenStreetMap/Nominatim connector config — `{enabled, base_url, user_agent}`, key `integrations.osm`, permissions `settings:integrations:read`/`settings:integrations:write` — an unconfigured/disabled connector reads as the zero value, not a 404; consumed by `core-front`'s `AddressWidget` via a Next BFF proxy route, never called from the browser directly, so the connector's own config — and any future API key it might need — never reaches client JS)
- `internal/auth/` — authentication (login/refresh/logout, JWT, permission DSL) plus the dedicated users/roles administration endpoints (`GET|POST /api/v1/users` + `GET|PUT /api/v1/users/:id`, same shape for `/api/v1/roles`). The auth tables are excluded from the generic CRUD surface on purpose, so these tenant-pinned, field-whitelisting handlers (email for users; name/description for roles) are the only HTTP path to them; the permission middleware derives `users:users:*` / `roles:roles:*` from the routes. A POSTed user is created **locked** — its password hash comes from discarded random bytes, so no credential matches until a dedicated password/invitation flow exists. They back the frontend's Settings → Users pages.
- `internal/pictures/` — the core picture service backing picture/signature field widgets: metadata in the `picture` table (off the generic CRUD surface, one picture per `(tenant, table, record, field)` anchor — POST replaces in place), bytes in S3-compatible object storage (`s3_*` config fields; Garage in dev — `infra/garage/README.md`, bootstrap `make garage-init`). Dedicated tenant-pinned routes `POST|GET /api/v1/pictures` + `GET|DELETE /api/v1/pictures/:id` (permissions `pictures:pictures:*` derived from the route); mounted only when `s3_*` is configured. See `docs/roadmaps/field-widgets.md` Phase 3.
- `internal/attachments/` — the non-image sibling of `internal/pictures`, for `boolean/file` field widgets storing an ARBITRARY file (a purchase invoice, a generated rent-receipt PDF — anything a picture's image whitelist would reject): same one-row-per-`(tenant, table, record, field)` anchor and S3-backed storage (reuses `pictures.NewS3Store`/`ObjectStore` verbatim, a second client instance off the same `s3_*` config — the object-store layer was already provider-agnostic, proven by `internal/reports` doing the same for PDF storage), but no mime whitelist and a real `Filename` column round-tripped as the download's `Content-Disposition` (a picture is only ever rendered inline as `<img>`, never offered as a named download). Dedicated tenant-pinned routes `POST|GET /api/v1/attachments` + `GET|DELETE /api/v1/attachments/:id` (permissions `attachments:attachments:*` derived from the route); mounted only when `s3_*` is configured, same gate as pictures.
- `internal/notebook/` — runtime, per-record notebook pages: a user's own tab on ONE record (e.g. "Meeting notes" on a single crm row), the third category ADR-007 names alongside descriptor structure (declared `page` layout nodes) and workspace `app_settings` — record-anchored content, mirroring `internal/pictures`' shape minus the object-storage leg (page content is text, stored directly in the `notebook_page` table: `tenant_id`/`table_name`/`record_id` anchor, `title` ≤200 chars, `position` int for stable append order, `content` text; soft-deletable, unlike `Picture`, since no per-anchor uniqueness invariant depends on the row's absence). Dedicated tenant-pinned routes `GET|POST /api/v1/notebook_pages` (query `table`+`record` for the list) + `PUT|DELETE /api/v1/notebook_pages/:id` (permissions `notebook_pages:notebook_pages:*` derived from the route — underscored, not hyphenated, so the route's static segments match the permission verbatim); mounted unconditionally (no external dependency to gate on, unlike pictures' `s3_*`). See `docs/roadmaps/responsive-displays.md` Phase 5 and `docs/adr/ADR-007-default-form-anatomy.md`.
- `internal/savedfilter/` — named, reusable search-bar filter combinations (`docs/adr/ADR-014-search-filter-bar.md`): a user builds a set of filters/group-by in one entity's search bar and saves it under a name, either private (owner-only) or shared (tenant-wide) — off the generic CRUD surface because "private OR shared" visibility is an OR-composed WHERE the generic repository's AND-only filter chain can't express, and rename/delete need an owner check a column-whitelist handler doesn't do. `SavedFilter` table: `tenant_id`/`user_id`/`entity`/`name`/`shared`/`config` (opaque JSON, never inspected server-side — the frontend re-validates field names/groups against the live descriptor before applying one), two hand-written partial unique indexes (`(tenant_id, user_id, entity, name) WHERE shared = false` and `(tenant_id, entity, name) WHERE shared = true` — two independent uniqueness scopes, not one). Dedicated tenant-pinned routes `GET|POST /api/v1/saved_filters` (query `entity` for the list, which returns the caller's own rows plus every other user's *shared* ones) + `PUT|DELETE /api/v1/saved_filters/:id` (owner-only, even on a shared row — no admin override in v1; permissions `saved_filters:saved_filters:*` derived from the route); mounted unconditionally, mirroring `internal/notebook`'s shape almost exactly.
- `internal/chatter/` — a record's activity feed: a user-posted comment or the frontend's own summary of a form edit, both stored as one `ChatterMessage` row (`kind` "message"/"log") anchored on `(tenant_id, table_name, record_id)`, the same shape `internal/notebook` uses. Unlike a notebook page, append-only — no `Update`/`Delete`, since an activity log reads wrong if entries can change after the fact. `AuthorEmail` is snapshotted at write time (resolved via `auth.UserRepository`, the same cross-package dependency `internal/settings` already takes) so a feed read never needs a per-message author lookup. Dedicated tenant-pinned routes `GET|POST /api/v1/chatter_messages` (query `table`+`record` for the list, newest first; permissions `chatter_messages:chatter_messages:read`/`write` derived from the route); mounted unconditionally. The frontend posts a `kind: "log"` entry itself after a successful form edit (`core-front/packages/core-front/src/views/renderers.tsx`'s `summarizeFieldChanges`) — Go never diffs a record's fields itself, it only stores whatever the caller (composer or form save) posts.
- `internal/cron/` — background scheduled actions (`docs/adr/ADR-016-cron-scheduler.md`). Unlike chatter/notebook/savedfilter, `Cron`/`CronHistory` ride the **generic CRUD surface** (`core/modules/cron/module.go`'s `orm.Register`, no `WithExcluded`) — that's what gives the frontend List/Kanban/Calendar/Graph for free, no bespoke view code. `Cron` is one-shot (`ExecutionDate`, cleared to nil after a run — not a recurring interval), names a Go `Action` by `ActionID`; `internal/cron.Register(Action{...})` is the extension point a module's own **`cron.go`** file calls from `init()` (mirrors `module.RegisterGoModule`'s shape), embedding its own source (`//go:embed cron.go`) into `Action.Source` so the form's read-only "Code" notebook page always shows the real code that runs. `Scheduler` (`scheduler.go`) polls every minute (`main.go`'s `go cronScheduler.Run(ctx)`), permission-checks the cron's `RunAsUserID` against the action's `RequiredPermission` (`auth.PermissionRepository.Has`) before running it, and records one `CronHistory` row (`Failed bool`, `LogsFilepath` — a local-disk text log under `Config.CronLogDir`, not S3) per attempt regardless of outcome; a missing-permission run also posts a `kind: "log"` `internal/chatter` message on the cron's own record, naming the action and the missing permission. The SAME tick also runs `SweepHistory` — the sliding-retention cleanup ("remove cron_history lines and files after N years"), a real `HardDelete` per row, where N is each cron's own `HistoryRetentionYears` field (0/unset = the 1-year default). `core/modules/cron/handler.go` overrides `POST`/`PUT /api/v1/cron` only (resolving `ActionCode` from the registry); every other verb, and all of `cron_history`, stays fully generic except one hand-mounted addition, `GET /api/v1/cron_history/:id/log` (downloads a run's log file, permission derived automatically from the route's existing `:id/action` shape).

### 2. WASM modules (`core/modules/`) — Go, cross-compiled to WASI
Each module lives in `core/modules/<name>/` and is Go source, not Rust — `make build` cross-compiles every module directory to `<dir>/build/<name>.wasm` via `GOOS=wasip1 GOARCH=wasm go build`. `module.json`'s `type` decides how the result is actually used: `"go"` compiles the module directly into the `core` binary (registered via `RegisterGoModule` in `core/modules/all/all.go`) and ignores its own built `.wasm` artifact; `"wasm"` instead loads that artifact dynamically at runtime through Wasmtime, via the detector's `module_root` scan — every module in this repo today is `"type": "go"`, so the WASM-loaded path is implemented and exercised by the detector/runtime but currently has no live module using it.

A `"wasm"`-type module directory must contain:
- `module.json` — module metadata (name, version, `active`, `depends`, `priority`, `type`)
- `*.wasm` — the compiled binary (auto-discovered by the detector)

Modules of either type may optionally export two WASM functions: `migrate()` returning a pointer and `migrate_len()` returning its byte length. The core reads the pointer from linear memory, deserializes the JSON `Migration` struct, and applies `add_column` operations via `ALTER TABLE`.

A module may also ship an optional `i18n/` folder (gettext `<name>.pot` template + one `<locale>.po` per language). The catalogs are consumed by the **frontend build**: the frontend's module discovery compiles them in and the UI offers them under Settings → Translations (see `core-front/CLAUDE.md`). The Go core owns only which language each user sees: the per-user `preferred_locale` on the user record and the workspace default in `app_settings` (see `internal/settings/`).

### 3. Frontend (`core-front/`) — Next.js (App Router) + TypeScript

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

The generic list endpoint (`GET /api/v1/{table}`) accepts, besides `page`/`page_size`, row filters: `filter[<column>]=<value>` (exact match, compared as text), `search[<column>]=<text>` (case-insensitive containment), `in[<column>]=<v1>,<v2>` (one of several values), and `gt[<column>]=`/`gte[<column>]=`/`lt[<column>]=`/`lte[<column>]=` (range comparisons, cast to `numeric` or `timestamptz` based on the column's Go type rather than `filter`/`search`'s uniform text cast — see `docs/adr/ADR-014-search-filter-bar.md`) — the relation widgets' scoping/autocomplete surface and the built-in search/filter bar's structured filters. `?distinct=<column>` (combinable with the above) returns that column's distinct values plus per-value row counts instead of a paginated page — the search bar's group-by section, riding the same route/permission rather than a new one (a literal new path segment would derive its own auto-permission no existing role has). Columns are whitelisted against the table meta in the handler (friendly 400) **and** in the repository (the security boundary — column names become SQL identifiers, values always bound as parameters) — as of ADR-014, the repository check is also group-aware (below), so a gated column is rejected identically to a nonexistent one across every one of these params.

**Field-level group gating** (`docs/adr/ADR-013-field-level-group-gating.md`): a module gates a column to callers whose resolved role-group set intersects it via `orm.Register[T](orm.WithFieldGroups(map[string][]string{"salary": {"hr_manager"}}))` — populates `FieldMeta.Groups`, empty (the default) meaning ungated. Enforcement is `core/orm/internal/crud.BuildResponse`, which omits a gated column's key entirely (never nulls it) from every generic CRUD response when the caller's groups don't intersect, **and** `Repository.checkColumn` (ADR-014), which every filter/search/in/range/distinct column goes through before it can touch SQL — closing what was originally a documented, accepted gap (filter/search used to be able to target a gated column and infer its values from which rows matched, even though the column itself never appeared in the JSON). The caller's groups travel through the request via `core/orm/access.WithGroups`/`GroupsFromContext` (mirrors `WithTenant`/`TenantFromContext` — a `context.WithValue` pair, so `core/orm` never imports `core/internal/auth`), stamped by `JWTMiddleware` from the JWT `groups` claim, itself resolved once at Login/Refresh as the technical-name closure of the user's roles plus every role they transitively "belong to" (`UserRepository.FindGroups`, a recursive CTE, cycle-safe via plain `UNION` dedup — see the ADR for the `role_belongs` table).

**Struct tags have no unique-constraint support** — only `,index`/`,index=<method>` (plain, non-unique). A table needing a unique constraint hand-writes it as SQL in its module's `Migrate()` hook, like any other DDL the auto-migration system can't derive (composite PKs, junction tables). `roles(tenant_id, technical_name)` is the first example.

## Configuration

`eerp-config.json` at the repo root is the dev config. Required fields include `module_root` (array of paths), `db_*` connection settings. The backend is started with:
```bash
go run main.go -config="../../eerp-config.json"
```

**Path resolution:** relative path fields (`module_root`, `api_config_path`) are anchored to the **config file's directory**, not the process CWD (`main.go` resolves them right after decoding; absolute paths pass through untouched). This keeps a single committed config portable — the app (run from `core/cmd/app`), tests (run from `core`), and the frontend build (run from `core-front`) all resolve `core/modules` to the same place. Prefer repo-relative paths in the committed config so it is relocatable across machines.

The Docker Compose service (`compose.yml`) runs PostgreSQL 18 on port 5432 with user/password `postgres` and database `poc`.

**Gateway (TLS + HTTP/2):** `api-gateway` (nginx, `infra/nginx/nginx.conf`) fronts the whole stack. Plain `http://localhost/` (port 80) 301-redirects to `https://localhost/` (port 443, self-signed dev cert) except `/healthz`, which stays on both — HTTP/2 only exists over TLS (browsers don't speak h2c), so :443 is the only HTTP/2 endpoint; Next↔Go stays plain HTTP/1.1 internally. The `gateway-certs` one-shot compose service provisions the self-signed cert into a shared volume before nginx starts (`infra/nginx/gen-certs.sh`, idempotent — regenerate by clearing the `gateway-certs` volume), so `docker compose up`/`make run` need no separate manual step. Swap in a real certificate for a public-facing deployment.

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