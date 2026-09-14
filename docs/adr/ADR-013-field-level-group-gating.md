# ADR-013: Field-level group gating + role "belongs" inheritance

**Status:** Accepted

## Context

Field visibility in EERP was either static (`FieldDescriptor.readOnly`/`invisible`) or
data-conditional (`states.visible`, a `Condition` reevaluated against the record's own draft
values — e.g. a status field flipping a comment field visible). Neither can hide a field from
*some users but not others*: the only identity-aware gate in the system is at the whole-route
level (`ViewDescriptor.permissions`, the `module:resource:action` DSL enforced by
`PermissionMiddleware`).

The ask: an Odoo-style security-groups model. A field declares `groups` (strings); a user only
receives it if their resolved role's technical name — or a role they transitively "belong to"
— matches one of those strings. The omission must be real (the data never leaves the backend
for a user without the group), not a client-side-only hide.

Two supporting gaps had to close first:

- **Roles had no stable, mutation-safe identifier.** `Roles.Name` is both the display label
  *and* the identifier `PermissionRepository`/the JWT `roles` claim already key off — reusing
  it as the group-matching key would mean a role rename silently changes which fields every
  holder of that role can see. A separate, deliberately non-displayed slug was needed.
- **No role-to-role relationship existed at all** — no hierarchy, no inheritance, not even a
  join table. "Belongs to" (Odoo's `implied_ids`) had to be built from nothing.

## Decision

### 1. `Roles.TechnicalName` is a new, separate, nullable column — `Name` is untouched

`Name` keeps doing exactly what it does today (display label, permission-system/JWT identity
key) — this ADR does not touch that flow. `TechnicalName *string` is additive: the slug a
field's `groups` list matches against. Nullable because the ORM's struct-tag auto-migration
has no `unique` modifier (`core/orm/internal/cache`), so the per-tenant uniqueness guarantee
(`idx_roles_tenant_technical_name`, a partial unique index `WHERE technical_name IS NOT NULL
AND deleted_at IS NULL`, hand-written in `core/modules/auth/module.go`'s `Migrate()` — the
first unique constraint in the codebase) would otherwise collide the moment a tenant has ≥2
pre-existing roles the instant the index went on. A role with no technical name simply
participates in no group gating.

### 2. `role_belongs` rides the generic CRUD surface, unlike every other auth table

`auth.RoleBelongs{RoleID, BelongsToRoleID}` (with `model.BaseModel`, unlike the composite-PK
`UserRoles`/`RolePermissions`) is registered via a plain `orm.Register[auth.RoleBelongs]()` —
deliberately **not** `WithExcluded()`. This is the one auth table exposed on `/api/v1/role_belongs`,
because it's what lets the frontend's existing many-to-many chips widget
(`RelationTagsWidget`/`RelationOps`) drive the Roles form's "Belongs" tab with zero new
endpoint or widget code — the same pattern any module's own m2m junction uses. The coarse
`role_belongs:role_belongs:*` permission this derives is a deliberate, smaller privilege than
the audited, whitelisted-field `AdminHandler` path `users`/`roles` themselves use; granting it
alongside `roles:roles:write` is judged an acceptable trade for reusing the widget.

### 3. Group resolution is a recursive CTE, resolved once at token-issue time

`UserRepository.FindGroups` walks the user's direct roles' `technical_name` plus every
transitively-`belongs_to` role's, via `WITH RECURSIVE ... UNION` (not `UNION ALL`) — plain
`UNION` dedupes visited role ids on every step, so a cycle (A belongs_to B belongs_to A) simply
stops re-adding an id already in the closure. No application-level visited-set or
cycle-detection code exists or is needed; Postgres's own duplicate elimination does the job.
Resolved once at `Login`/`Refresh` (exactly where `roles`/`permissions` already get resolved)
and baked into a new JWT `groups` claim — no DB round-trip per request, same posture as the
existing `permissions` claim.

### 4. Groups travel through a request via `core/orm/access`, not an import of `core/internal/auth`

`core/orm/internal/crud.BuildResponse` — the single chokepoint every generic CRUD response
(list, get, create, update, restore) passes through — needs the caller's resolved groups, but
`core/orm` is meant to stay auth-agnostic (root `CLAUDE.md`: "ERP code only imports the
`core/orm` facade"). `core/orm/access` already solves exactly this problem for the tenant ID
(`WithTenant`/`TenantFromContext`, a `context.WithValue` pair `JWTMiddleware` populates and the
CRUD layer reads back with no import cycle) — `access.WithGroups`/`GroupsFromContext` is the
same pattern for groups, one more line in `JWTMiddleware`.

### 5. Gating is declared per-field via a Go `Option`, not `api.yaml`

`WithFieldGroups(map[string][]string)` (column → groups) sits alongside `WithReadOnlyFields`/
`WithExcludeFields` in shape, but unlike them has no `api.yaml` twin. Those two exist so an
*operator* can override another module's code without a rebuild; group-gating is a
module-author decision made at the same time as the field's own `orm.Register` call, so there
is no equivalent need. `FieldMeta.Groups` (empty = ungated) is populated at registration and
read by `BuildResponse`, which skips a field's key entirely — never nulls it — when the
caller's groups don't intersect. A field with no `Groups` declared is completely unaffected:
zero behavior change for every table that doesn't use this.

### 6. `FieldDescriptor.groups` on the frontend is a UX mirror, not the security boundary

The server omission in (5) already makes a gated field simply absent from the fetched draft.
`FieldDescriptor.groups?: string[]` + `isFieldVisible`'s new `callerGroups` parameter (read
from `useSessionStore`'s new `Identity.groups`, itself decoded from the JWT `groups` claim in
`identityFromAccessToken`) exist only so the widget doesn't render an empty/broken slot for a
field the caller was never sent. `callerGroups` is optional and fail-open when absent — every
existing `isFieldVisible` call site keeps compiling and keeps its old behavior.

## Consequences

- **`filter[col]=`/`search[col]=` are NOT group-aware.** `BuildResponse` strips a gated
  column from every response body, but `generic_handler.go`'s `listFilter` performs no
  equivalent check — a caller without the group can still `filter[unit_price]=99.90` or
  `search[unit_price]=9` against the generic list endpoint and infer values from which rows
  match, without the column ever appearing in a response. This is a real, smaller gap than
  full field secrecy, left open deliberately: the ask was specifically for response-body
  omission, and closing this means validating filter/search column names against the caller's
  groups the same way `BuildResponse` does — a natural, contained follow-up, not attempted
  here. **Closed by `docs/adr/ADR-014-search-filter-bar.md`** (`Repository.checkColumn`).
- **`role_belongs` sits on the generic CRUD surface** — the one deliberate exception to
  "the auth tables are excluded on purpose" (`core/modules/auth/module.go`'s own comment on
  `Users`/`Roles`/`Permissions`/`RefreshTokens`). A tenant admin with `role_belongs:role_belongs:write`
  can create/remove belongs-edges directly against the generic endpoint, bypassing whatever UI
  affordance exists — acceptable because the edge itself (which role implies which group) is
  lower-stakes than the identity/credential data the other auth tables guard.
- **No FK constraint enforces `role_belongs.belongs_to_role_id` staying inside the same
  tenant** beyond the generic CRUD layer's own `tenant_id` scoping — matches this repo's
  existing no-FK convention on cross-entity references.
- **Groups are resolved at token-issue time, not per-request.** A `role_belongs` edge added
  mid-session doesn't affect an already-issued access token until the next `Refresh` — the same
  staleness window `permissions` already has, accepted for the same reason (no DB round-trip
  per request).

## Reference implementation

`core/internal/auth/models.go` (`Roles.TechnicalName`, `RoleBelongs`), `core/modules/auth/module.go`
(`RoleBelongs` registration + the unique-index `Migrate()` addition), `core/orm/access/groups.go`,
`core/internal/auth/user_repository.go`'s `FindGroups`, `core/internal/auth/token.go`/`handler.go`/
`identity.go` (the `groups` JWT claim plumbing), `core/orm/internal/registry/registry.go`'s
`WithFieldGroups`/`FieldMeta.Groups`, `core/orm/internal/crud/dto.go`'s `BuildResponse`,
`core/internal/auth/admin_handler.go`/`admin_repository.go` (`technical_name` threading +
`ErrDuplicateTechnicalName`), `core-front/packages/core-front/src/views/descriptor.ts`
(`FieldDescriptor.groups`, `isFieldVisible`), `layout-renderer.tsx`, `session-store.ts`,
`apps/shell/src/lib/jwt.ts`, and `apps/shell/app/settings/users/descriptors.ts`'s
`roleFormDescriptor` (the "Belongs" tab) are the primary surfaces.
