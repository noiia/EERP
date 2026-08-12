# ADR-014: Built-in search/filter bar for list views

**Status:** Accepted

## Context

Every list (`viewType: 'tree'`) view had no search or filtering affordance beyond what a
module manually wired one-off (e.g. relation widgets' autocomplete, which only ever targets
one relation field). Users could not narrow a list by an arbitrary form field, group records
by a field's real distinct values, or save a filter combination for reuse — and whatever a
module *did* build itself would have been bespoke, non-reusable UI, the same "one feature,
one special case" problem ADR-011's form actions menu solved for custom form actions.

The ask: a search bar every list view gets automatically (no per-descriptor opt-in — the
same "structural chrome the engine always provides" posture `CreateBar` and the
List/Kanban/Calendar/Graph mode switcher already take), filtering entirely server-side
through the ORM (never client-side), respecting the existing field-level group gating
(`docs/adr/ADR-013-field-level-group-gating.md`) so a user only sees/uses filter fields their
groups grant, with a group-by section reflecting a field's *actual* distinct values (not a
predeclared static list, unlike Kanban's status columns), and named filter combinations a
user can save privately or share with their tenant.

This also **closes a gap ADR-013 already named and deliberately deferred**: `filter[col]=`/
`search[col]=` on the generic list endpoint were not group-aware — a caller lacking a
field's group could filter/search on it and infer values from which rows matched, even
though the column never appeared in the response body. Closing that gap is this ADR's first,
foundational decision — every new filter capability below must be safe from day one, not
bolted onto an already-leaky check.

## Decision

### 1. `Repository.checkColumn` closes the ADR-013 gap, and every new filter goes through it

`core/orm/internal/crud/repository.go`'s `filterConditions` used to validate a filter column
only against `TableMeta.HasField` (the identifier whitelist). `checkColumn` adds the SAME
group check `BuildResponse` already applies to response bodies: a column carrying
`FieldMeta.Groups` is rejected with the identical `ErrUnknownColumn` a nonexistent column
gets — indistinguishable on purpose, mirroring `BuildResponse`'s "omit, don't reveal"
posture. Every new filter kind below (`In`, `GT`/`GTE`/`LT`/`LTE`, and `DistinctValues`'
`column` argument) reuses this ONE function, so gating a field via `WithFieldGroups` makes it
invisible to filtering/searching/grouping automatically — no separate opt-in.

### 2. Structured filters extend `ListFilter` with parallel maps, not a generic operator DSL

The existing shape was `Equals map[string]string` / `Matches map[string]string`. This adds
`In map[string][]string` (`col::text = ANY($1)`) and `GT`/`GTE`/`LT`/`LTE map[string]string`
(range comparisons) — five more maps, the same flat, no-abstraction shape the two originals
already use. A "between" is just a `GTE` condition and an `LTE` condition on the same column
— no separate operator. `is_empty`/`is_set` and OR-composition between conditions are
explicitly out of scope for v1: nothing in the current UI needs them, and adding them now
would be speculative. Range comparisons need a **type-aware cast** unlike `Equals`/`Matches`'
uniform `::text` (lexicographic `>`/`<` on text is wrong for numbers and non-ISO dates) —
`rangeCast(goType string)` picks `numeric` or `timestamptz` from `FieldMeta.GoType`.

### 3. Group-by rides the existing list endpoint via `?distinct=<column>`, not a new route

`derivePermissionFromRoute` (`core/internal/middleware/permission.go`) derives a permission
from a route's *static path segments before the first `:param`*. A literal new route like
`GET /api/v1/{table}/distinct` would derive `table:distinct:read` — a permission no existing
role has, meaning every tenant admin would need to grant a brand-new permission per table
before group-by worked at all. Folding it into the existing `GET /api/v1/{table}?distinct=col`
keeps the same route, the same already-granted `table:table:read` permission, and — because
it shares `listFilter`'s param parsing — the same `checkColumn` gating from decision 1, for
free. `Repository.DistinctValues` builds `SELECT col::text AS value, COUNT(*) AS total ...
GROUP BY col` via `query.SelectBuilder`'s `GroupBy`/`Columns` (already existed, unit-tested,
simply never wired to the CRUD surface before this) — one query gets both the distinct values
AND their per-bucket counts, so no separate `.Distinct()` builder method was needed.
`distinctCap = 500` is a named ceiling (`// ponytail: 500-value ceiling, paginate if a real
field blows past it`), not a silent limitation.

### 4. Saved filters get a dedicated Go package, mirroring `internal/notebook`

"Private OR shared" visibility is an OR-composed WHERE (`user_id = $1 OR shared = true`) the
generic repository's AND-only `.Where()` chain cannot express — `orm.Cond(...)`'s raw-SQL
escape hatch is the documented way to write OR in this ORM, and `internal/savedfilter`'s
`ListVisible` is the concrete proof the generic CRUD surface doesn't fit here. Rename/delete
also need an owner check a bare column-whitelist handler doesn't do (an owner-only rule that
applies even to a filter someone marked shared — no admin-override affordance in v1).
`SavedFilter{TenantID, UserID, Entity, Name, Shared, Config}` — `Config` is opaque JSON at
this layer (the same posture `app_settings`' Kanban/Graph config already takes: the backend
validates shape, never semantics), off the generic CRUD surface (`orm.WithExcluded()`),
dedicated tenant-pinned routes under `/api/v1/saved_filters`.

**Schema**: two hand-written partial unique indexes, not one — struct tags have no
unique-constraint support (root `CLAUDE.md`), and private/shared are genuinely independent
uniqueness scopes, not one column pair:
```sql
CREATE UNIQUE INDEX idx_saved_filter_private_name
  ON saved_filter (tenant_id, user_id, entity, name) WHERE shared = false AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_saved_filter_shared_name
  ON saved_filter (tenant_id, entity, name) WHERE shared = true AND deleted_at IS NULL;
```
This was chosen over a single `coalesce(user_id, '00000000-...')`-style compound index: no
magic sentinel UUID with no other meaning in the schema, and each index documents exactly one
uniqueness scope, matching `idx_roles_tenant_technical_name`'s one-index-one-purpose
convention. `app_settings` (a single JSON blob per key) was considered and rejected: it has
no `user_id` column and no per-row addressing, so renaming or deleting ONE saved filter would
mean a read-modify-write race on the whole blob — acceptable for Kanban/Graph's
admin-editable, rarely-concurrent config, not for a "save my search" feature real users hit
constantly.

### 5. Per-module customization is a descriptor field, not a new registry or extension op kind

`ViewDescriptor.search?: SearchDescriptor` (`liveFields`, `filterableFields`,
`groupableFields`) is plain, RSC-safe DATA — read eagerly every render, the same posture
`ViewDescriptor.catalog`/`.actions` already take, validated at registration
(`validateSearchDescriptor`, wired into `registry.ts`'s `validateDescriptor` exactly like
`validateCatalogDescriptor`). A module overriding ANOTHER module's search bar uses the
*existing* View Extensions `setDescriptor` op, whose patch whitelist widened by one key
(`'search'` added to `Partial<Pick<ViewDescriptor, 'formPath' | 'createPermission' |
'permissions' | 'search'>>`) — a whole-block replace, same as the other three keys, no deep
merge. No new `register*`-style named behavior registry (like `registerMenuAction`) and no
new `Operation` kind were introduced: the config here is data an extension can already patch
wholesale, and a bespoke deep-merge operation for one config block — when the three existing
`setDescriptor` fields never needed one — would be exactly the kind of unrequested
abstraction the "don't build for a hypothetical future" convention warns against.

### 6. The bar lives inside `TreeRenderer`, and the live-typing leg needs zero backend change

`SearchBar` mounts in `TreeRenderer` (`packages/core-front/src/views/renderers.tsx`), in the
same slot as the List/Kanban/Calendar/Graph mode switcher — renderer-owned, always rendered,
not host-page-rendered like `CreateBar` — because applying a filter/group-by needs to drive
the SAME `liveRecords` state Kanban/Calendar drags already share, so a filter result shows up
identically across every mode with zero new state-sync code. "Typing does live search,
priority 1st name, 2nd id, 3rd module-specified fields" is implemented as up to 3 sequential
debounced calls to the *existing* single-column `search[col]=` endpoint (reusing
`RelationOps.list()`, which already accepts any entity, not just relation targets — no new
ops context needed for this leg), merged and de-duplicated by id client-side. Every match is
still a real server-computed `ILIKE` result; the only client-side work is sequencing/merging
already-filtered server pages, consistent with "never compute filters client-side." This is a
deliberate, documented exception to the engine's "no fetch on mount" state-model contract —
the same class of exception `relation-widgets.tsx`'s `useRelationSearch` already is.

Two independent filtering paths — the live-typed query and the dropdown's structured
filters — both write into the same `onResults`; composing them into one request (an OR-search
AND'd with structured filters) is left for a follow-up once a real use case asks for it.

## Consequences

- The live-search leg costs up to 3 sequential round-trips per keystroke (debounced) instead
  of 1. If that proves laggy in practice, the upgrade path is a real backend OR-search
  endpoint — not built now, since it would be speculative ahead of a demonstrated need.
- Saved filters are owner-only to rename/delete, even when shared — no admin-override
  affordance exists in v1 (a shared filter someone else created can be used by the whole
  tenant, but only its creator can change or remove it).
- `SavedFilter.Config` is opaque JSON the backend never validates semantically (field names,
  operator/type pairs) — the frontend re-validates against the live descriptor
  (`isFieldVisible`, `filterableFields`) when a saved filter is applied, so a filter saved
  before a field was removed/regated degrades gracefully rather than erroring.
- `distinct=<column>` shares `table:table:read` rather than deriving its own permission —
  intentional (decision 3), but means group-by cannot be gated more narrowly than ordinary
  reads of the table without a future, separate permission design.

## Reference implementation

Backend: `core/orm/internal/crud/repository.go` (`checkColumn`, `filterConditions`,
`DistinctValues`), `core/orm/internal/crud/service.go` (`ListFilter`, `DistinctValue`),
`core/orm/internal/handler/generic_handler.go` (`listFilter` param parsing, the `distinct=`
branch), `core/internal/savedfilter/` (model/repository/handler), `core/modules/savedfilter/`
(registration + the two-index `Migrate()`), `core/cmd/app/main.go` (route mount).

Frontend: `packages/core-front/src/views/descriptor.ts` (`SearchDescriptor`,
`validateSearchDescriptor`, `FilterCondition`), `packages/core-front/src/registry/extensions.ts`
(`SetDescriptorOp` whitelist), `packages/core-front/src/views/search-bar.tsx` (`SearchBar`,
the live-search leg, the Filters/Group-by/Saved-filters dropdown), `packages/core-front/src/views/saved-filter-ops.tsx`
(`SavedFilterOps`, mirroring `NotebookOps`'s shape), `packages/core-front/src/views/renderers.tsx`
(`TreeRenderer`'s `SearchBar` mount point), `packages/core-front/src/api/list-options.ts` /
`ApiClient.ts` (`EntityListOptions`'s `in`/`gt`/`gte`/`lt`/`lte`, `distinctValues`).
