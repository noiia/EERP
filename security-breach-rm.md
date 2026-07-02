# Security Remediation Roadmap

Fixes for the **real code-level breaches** found in the audit. Dev-environment config
values (the committed `master_key`, `seed_dev_admin: true`, `postgres/postgres` DB creds)
are intentional for local dev and are **out of scope** here — they are deployment/secret
concerns, not code vulnerabilities.

**Legend:** 🔴 Critical · 🟠 High · 🟡 Medium
Status: `[ ]` todo · `[~]` in progress · `[x]` done

---

## 1. 🔴 Enforce tenant isolation in the generic CRUD layer — [x] MECHANISM DONE

**The headline breach — cross-tenant IDOR / broken access control.**

**Status:** the framework mechanism is implemented and tested. Any registered
table carrying a `tenant_id` column is now automatically isolated; `users` and
`roles` (both tenant-owned and exposed via generic CRUD) are protected. See the
follow-up note below on business tables that still lack a `tenant_id` column.

**What shipped:**
- New `core/orm/access` package holds the request-scoped tenant (kept out of the
  app's auth package so the ORM stays a self-contained framework — no import cycle).
- `JWTMiddleware` stamps `access.WithTenant(ctx, identity.TenantID)` after auth.
- `crud.Repository` scopes every operation to the caller's tenant when the table
  has a `tenant_id` column: `FindAll` (count + page), `FindByID`, `Update`,
  soft/hard `Delete`, and `Restore` all get `WHERE tenant_id = $tenant`; `Create`
  forces `tenant_id` server-side (ignoring any client value); `Update` refuses to
  change `tenant_id` (immutable — no moving a row across tenants).
- **Fail-closed:** a tenant-scoped table accessed with no tenant in context returns
  `crud.ErrTenantMissing` rather than an unscoped, all-tenants query.
- Tables without a `tenant_id` column stay global by design (e.g. the shared
  `permissions` catalog).
- Tests: `orm/internal/crud/repository_test.go` (scoping on every verb, tenant
  forced on create, immutable on update, fail-closed, and global-table pass-through).

**Follow-up (data model — not yet done):** `contacts` and the `crm` entities have
**no `tenant_id` column**, so they are global by schema and the mechanism does not
(and cannot) isolate them. To make them tenant-owned, add a `TenantID` field to
those models (auto-migration will add the column) — then isolation applies
automatically with no further CRUD changes. Tracked as item 1a below.

### 1a. 🟠 Add `tenant_id` to tenant-owned business entities — [x] DONE
- **Files:** `core/modules/contact/internal/contacts.go`,
  `core/modules/crm/internal/crm.go`, `core/orm/internal/crud/dto.go`.
- **What shipped:**
  - Added `TenantID uuid.UUID \`db:"tenant_id"\`` to `Contact` and `CRM` (the latter
    also flows into `crminheritdemo`'s extended CRM, which embeds it). The
    auto-migration adds the column via `ALTER TABLE ... ADD COLUMN`, so both tables
    are now covered by the item-1 isolation mechanism automatically.
  - Marked `tenant_id` as server-generated in `dto.go` so the generic CRUD create
    validation does not demand it from clients — the repository forces it from the
    caller's identity.
  - Tests: `modules/contact/module_test.go`, `modules/crm/module_test.go` assert
    each table carries `tenant_id`.
- **Caveat (dev DBs):** the new column is `NOT NULL`. On a **fresh** database it
  migrates cleanly. On an existing dev DB that already has `contact`/`crm` rows,
  `ADD COLUMN ... NOT NULL` will fail — reset the POC database (or backfill
  `tenant_id` and add the column manually) after pulling this change.
- **Follow-up:** a DB-backed integration test proving cross-tenant reads/writes on
  contacts are blocked (needs `TEST_DSN`); the unit-level invariant is covered by
  `repository_test.go` + the two module tests.

---

### Original plan (for reference)

- **Files:** `core/orm/internal/crud/repository.go`,
  `core/orm/internal/crud/service.go`,
  `core/orm/internal/handler/generic_handler.go`,
  `core/orm/internal/registry/registry.go`,
  `core/internal/auth/identity.go`
- **Problem:** `FindAll`, `FindByID`, `Update`, `Delete` filter only on primary key and
  `deleted_at IS NULL`. `Identity.TenantID` is never used by the CRUD path, so any
  authenticated user can list/read/update/delete rows belonging to **other tenants**
  (contacts, users, roles, permissions) by ID or via the list endpoint.
- **Do:**
  - Flag tenant-owned tables in `TableMeta` (detect a `tenant_id` column, or add an
    explicit `WithTenantScoped()` registration option).
  - Thread `Identity.TenantID` from the request context into the service/repo layer.
  - Reads on scoped tables: inject `WHERE tenant_id = $tenant`.
  - Writes on scoped tables: set `tenant_id` server-side on create; ignore/reject any
    client-supplied `tenant_id`; block cross-tenant update/delete.
  - Return `404` (not `403`) for other-tenant IDs to avoid existence disclosure.
- **Acceptance:** Integration test proves a tenant-A token cannot list/read/update/delete
  a tenant-B row; the list endpoint returns only the caller's tenant.

---

## 2. 🟠 Scope the exposed auth tables (`users` / `roles` / `permissions`) — [x] DONE

- **Files:** `core/modules/auth/module.go`, `core/orm/internal/registry/registry.go`,
  `core/orm/migrate.go`.
- **Problem:** These were served by the auto-generated CRUD. That is a
  privilege-escalation / cross-tenant integrity surface: a caller with the right
  permission could mutate the **global** permission catalog (no `tenant_id`), create
  password-less users, or delete roles. No feature (frontend or otherwise) actually
  uses generic CRUD on them.
- **Fix (done):** take all four auth tables off the HTTP surface with `WithExcluded()`
  (`users`, `roles`, `permissions`, and `refresh_tokens`). They remain registered so
  their schemas migrate and the typed repos / auth flows keep working. Account, role,
  and permission management must go through dedicated, audited endpoints — never the
  generic CRUD (that dedicated surface is future work; the dangerous auto-CRUD is now
  closed, fail-closed).
- **Latent bug fixed along the way:** `Excluded` previously removed a table from
  `registry.All()`, which the **migration** layer also used — so excluded tables
  (`refresh_tokens`) were never auto-migrated in the real app. Split the concepts:
  `All()` = HTTP surface (excludes), new `AllRegistered()` = every registered table
  (for migration). `RegisteredTableNames()` now uses `AllRegistered()`, so excluded
  tables migrate correctly.
- **Tests:** `modules/auth/module_test.go` (the four tables are registered/migrated but
  not exposed), `orm/internal/registry/registry_test.go`
  (`AllRegistered` includes excluded, `All` does not). Also added `orm.ExposedTableNames()`
  for auditability.
- **Note:** `password_hash` stays excluded from input/output regardless (item 5), and
  since users/roles are tenant-scoped (item 1) any future dedicated endpoints inherit
  that isolation.

---

## 3. 🟡 Make permission enforcement consistent and fail-closed — [x] DONE

- **Files:** `core/internal/middleware/permission.go`,
  `core/internal/middleware/export_test.go`, `core/internal/middleware/permission_test.go`.
- **Problems (fixed):**
  - The middleware fell through with `next(c)` when no permission could be derived —
    an unexpected method/shape **bypassed authorization** (fail-open).
  - Derivation parsed the raw URL, so item routes produced `table:<uuid>:action`
    while collection routes produced `table:table:action`. Exact-scoped permissions
    were inconsistent between the two, pushing operators toward wildcard grants.
- **Fix (done):**
  - Derive from the **matched route pattern** (`c.Path()`, e.g. `/api/v1/crm/:id`)
    instead of the raw URL. The resource is taken from the static segments before the
    first path parameter, so item, collection and `:id/restore` routes for a table all
    resolve to the SAME `module:resource:action` (the id never leaks into the resource;
    the `restore` suffix folds into the write action).
  - Fail **closed**: an empty derived permission now returns 403 instead of passing
    through.
  - Refactored `PermissionMiddleware` to take a small call-site `permissionChecker`
    interface (`*auth.PermissionRepository` still satisfies it) so the allow/deny paths
    are unit-testable without a DB.
- **Tests:** `permission_test.go` covers item==collection consistency, the restore
  suffix, fail-closed cases (unknown method / OPTIONS / no resource segment), and
  allow (200) vs deny (403) through a real `:id` route asserting the id doesn't leak.
- **Acceptance:** met — list and item routes require the same permission; unknown
  method/shape is denied; tests cover both.

---

## 4. 🟡 Fix the broken login timing-attack mitigation — [x] DONE

- **Files:** `core/internal/auth/handler.go`, `core/internal/auth/export_test.go`,
  `core/internal/auth/timing_test.go`.
- **Problem:** The placeholder `"$2a$12$placeholder_hash_for_timing_____"` is not a valid
  bcrypt hash, so `CompareHashAndPassword` errored out instantly instead of doing the
  KDF. The unknown-user path stayed measurably faster → account enumeration via timing.
- **Fix (done):** the handler now compares against `dummyHash`, a real bcrypt hash
  generated once at startup at `bcrypt.DefaultCost` (the same cost as stored passwords,
  so it tracks any future cost change). The unknown-user path now runs the full KDF,
  matching a real credential check.
- **Tests:** `timing_test.go` asserts the dummy hash is a valid bcrypt hash at
  `DefaultCost` and that comparing against it performs real work (returns
  `ErrMismatchedHashAndPassword`, not an invalid-hash short-circuit).

---

## 5. 🟠 `api.yaml` security controls failed open — [x] DONE

- **Files:** `core/orm/internal/registry/registry.go`, `core/orm/register.go`,
  `core/modules/auth/module.go`, `core/internal/auth/models.go`, `core/cmd/app/main.go`,
  `api.yaml`
- **Problem:** Field/table exclusions that protect secrets lived only in `api.yaml`, and
  the loader failed **open** — `ensureAPIConfig` silently ignored a missing or malformed
  file, and `main.go` only logged a `Warn`. A typo, a mis-resolved path, or the file not
  shipping would silently expose `users.password_hash` in every response and mount full
  public CRUD on `refresh_tokens` (list/delete every user's token hashes).
- **Fix (done):**
  1. `password_hash` exclusion is code-only now (`WithExcludeFields`); removed the
     redundant `api.yaml` entry so there is one source of truth.
  2. Added a `WithExcluded()` register option; `refresh_tokens` is excluded from the HTTP
     surface in code instead of via `api.yaml` (still registered for ORM/migrations).
  3. `LoadAPIConfig` now fails **closed**: a configured path that is missing or malformed
     returns an error, and `main.go` treats that as fatal (refuses to start). `api.yaml`
     is reduced to cosmetic overrides only, with a header documenting the boundary.
- **Tests:** `TestWithExcluded_KeepsTableOffHTTPSurface`,
  `TestLoadAPIConfig_FailsClosedOnMalformedYAML`,
  `TestLoadAPIConfig_FailsClosedOnMissingFile` (all green).

---

## Hardening (optional, not exploitable breaches)

- [ ] 🟡 **Lock down CORS** — `core/orm/server/server.go` (~L62): replace
  `AllowOrigins: ["*"]` with the known frontend origin(s), configurable via config/env.
- [ ] 🟠 **Login rate limiting / lockout** — `core/orm/server/server.go`,
  `core/internal/auth/handler.go`: throttle `/api/v1/auth/login` (IP + account) to blunt
  brute force.
- [ ] **Request body-size limit** — add `middleware.BodyLimit(...)` to bound payloads.
- [ ] **Transactional refresh rotation** — `core/internal/auth/refresh_store.go`: wrap
  `RevokeAll` + `Create` in one transaction so a crash can't strand a user without a
  valid refresh token.

---

## Suggested order

1. **#1 tenant isolation** — the actual critical breach; do first.
2. **#2 auth-table scoping** — falls out of #1, close the escalation surface.
3. **#3 permission consistency/bypass** — real authz gap.
4. **#4 timing mitigation** — small, self-contained fix.
5. Hardening items as capacity allows.

Add an integration test for the tenant-isolation invariant so the #1 regression fails CI.
