# Security Remediation Roadmap

Fixes for the **real code-level breaches** found in the audit. Dev-environment config
values (the committed `master_key`, `seed_dev_admin: true`, `postgres/postgres` DB creds)
are intentional for local dev and are **out of scope** here — they are deployment/secret
concerns, not code vulnerabilities.

**Legend:** 🔴 Critical · 🟠 High · 🟡 Medium
Status: `[ ]` todo · `[~]` in progress · `[x]` done

---

## 1. 🔴 Enforce tenant isolation in the generic CRUD layer

**The headline breach — cross-tenant IDOR / broken access control.**

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

## 2. 🟠 Scope the exposed auth tables (`users` / `roles` / `permissions`)

- **Files:** `core/modules/auth/module.go`, `api.yaml`,
  `core/orm/internal/crud/*`
- **Problem:** These are served by the auto-generated CRUD. Combined with #1 this is a
  cross-tenant read/write and privilege-escalation surface (e.g. mutate roles/permissions
  outside your tenant).
- **Do:**
  - Ensure all three are tenant-scoped via #1.
  - Consider replacing the generic CRUD for these with dedicated handlers that enforce
    invariants (cannot grant permissions/roles outside your tenant, cannot self-assign).
  - Confirm `password_hash` stays excluded from input **and** output (currently correct)
    and `refresh_tokens` stays `exclude: true`.
- **Acceptance:** A non-admin cannot escalate via role/permission CRUD; denied paths
  covered by tests.

---

## 3. 🟡 Make permission enforcement consistent and fail-closed

- **Files:** `core/internal/middleware/permission.go`
- **Problems:**
  - When a permission can't be derived, the middleware falls through with `next(c)` —
    non-standard methods (`methodToAction` → `""`) **bypass authorization**.
  - Item routes derive `table:<uuid>:action` while list routes derive
    `table:table:action`, so exact-scoped permissions behave inconsistently and push
    operators toward over-broad wildcard grants.
- **Do:**
  - Default to **deny** (403) when no permission can be derived, or explicitly allowlist
    handled methods.
  - Normalize the resource segment so `/{table}/{id}` derives the same
    `module:resource:action` as the list route (treat `:id` as the record, not the
    resource). Update `derivePermissionFromPath` and its tests.
- **Acceptance:** List and item routes for the same table require the same permission;
  unknown method/shape is denied; tests cover both.

---

## 4. 🟡 Fix the broken login timing-attack mitigation

- **Files:** `core/internal/auth/handler.go` (unknown-user branch)
- **Problem:** The placeholder `"$2a$12$placeholder_hash_for_timing_____"` is not a valid
  bcrypt hash, so `CompareHashAndPassword` errors out instantly instead of doing the KDF.
  The unknown-user path stays measurably faster → account enumeration via timing.
- **Do:** Replace with a real precomputed bcrypt hash (cost 12) of a dummy password so
  both paths do equal work.
- **Acceptance:** Unit test asserts the constant is a valid bcrypt hash; known vs unknown
  user timings are comparable.

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
