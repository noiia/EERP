# Conventions (contracts — source of truth)

These are the stable contracts every part of the EERP frontend (engine, Next host, and business
modules) must honor. This file is the single source of truth; point Claude Code at it when
implementing any task.

The frontend is a **standalone Next.js service** (App Router, RSC/SSR). It runs as its own process
and talks to the Go backend **only over HTTP** (a BFF boundary). The server owns data, caching,
session, and authorization; **Zustand** owns client interaction + UI state.

| Concern | Contract |
| --- | --- |
| Backend base URL | `{API_BASE}/api/v{API_VERSION}` — **server-side env** (`API_BASE`, `API_VERSION`, default `1`). Never exposed to the browser; the browser calls Next, Next calls Go. |
| Module routes (Go) | `/{module}/` (list, create) + `/{module}/{id}` (get, update, delete). CRM contacts → `/crm/` + `/crm/{id}` |
| Core routes (Go) | `GET /health`, `GET /ready`, `GET /modules` |
| Auth (Go) | `POST /auth/login {email, password}`; `POST /auth/refresh` |
| Session transport | **BFF**: Next exchanges credentials with Go, stores the token in an **HttpOnly cookie on the Next domain**, and resolves identity **server-side** (`next/headers` `cookies()`). The token never reaches client JS. The client holds only a non-secret **session mirror** (identity + permissions) for UI gating. |
| Token TTLs | access **1h**, refresh **7d**, refresh **single-use** (rotation). Reusing a spent refresh = theft → Go kills session → Next clears the cookie → redirect to `/login`. |
| Error envelope (Go) | `{ "error": { "code": "UPPER_SNAKE", "message": "...", "request_id": "01J..." } }` |
| Status map | 400 validation · 401 unauthenticated · 403 forbidden · 404 not found · 409 conflict · 500 `INTERNAL_ERROR` |
| Permissions | DSL `module:resource:action` (`crm:contacts:` then `read` / `write` / `delete`). Wildcards `*:*:read`, `crm:*:read`. **Server** authorizes (RSC/route guard); **client** `<Can>` gates UI off the session mirror. |
| Delete | Soft-delete by default (ADR-003). `remove` archives; add `restore` when backend exposes it. |
| View types (v1) | `form`, `tree`, `dashboard`. New entity = a descriptor; new view type = one store factory + one renderer + one server loader path. |
| Layout tree | `ViewDescriptor.layout?: LayoutNode[]` — a presentational tree over `fields` (`{ kind: 'group'\|'row'\|'section', id?, title?, children }` containers, `{ kind: 'field', name }` leaves), addressed by field name or an explicit `id` (the anchor a view EXTENSION targets — `docs/roadmaps/view-customization.md`). Omitted ⇒ `normalizeLayout()` synthesizes one implicit, untitled group wrapping every field in declaration order — full back-compat, zero renderer change for descriptors that predate the tree. **Every renderer goes through `normalizeLayout()`** — `FormRenderer` (`layout-renderer.tsx`'s `LayoutForm`, also reused by the relation widgets' create-from-search wizard) and `TreeRenderer`'s DataGrid columns / hierarchy label field (via `layoutFieldOrder()`) — never `descriptor.fields` directly for display order/grouping. `normalizeLayout` validates every field-leaf exists in `fields`, no field appears twice, every `id` is unique; violations are a registration-time error naming the field/id, not a silently dropped node. |
| Field states | `FieldDescriptor.states?: { visible?; readOnly?; required?: Condition }`, `Condition = { field, op: 'eq'\|'ne'\|'in'\|'set'\|'unset', value? } \| { all: Condition[] } \| { any: Condition[] }` — a declarative expression, never a function (RSC boundary), evaluated by `evaluateCondition()` against the CURRENT DRAFT on every render, so states react live to the user's own edits (e.g. a status field flipping a comment field visible) with no extra plumbing. `visible: false` unmounts the field in `LayoutForm` WITHOUT touching its draft value — toggling it back on shows whatever was last set. `readOnly: true` ORs into the widget's disabled state (alongside the existing compute-disables rule; a future static `FieldDescriptor.readOnly` from the app-store roadmap will compose here too — static wins). `required: true` (state-derived or the static flag) blocks `commit()` via `requiredMissing()`, surfaced through the form's existing `ApiError` slot (`code: 'VALIDATION_ERROR'`) — but ONLY among currently visible fields; a hidden field can never block commit. |
| View extensions | `FrontModule.extends?: ViewExtension[]`, `ViewExtension = { path, operations: Operation[] }` (`src/registry/extensions.ts`) — a module reshapes ANOTHER module's (or its own) already-registered route without touching its code: `addField`/`removeField`/`setField`/`move`/`addNode`/`setDescriptor`, applied by the pure `applyExtension()` and run once per module at `ModuleRegistry.register()` time — `ModuleRegistry` keeps a `resolvedRoutes` map (base descriptor, then each extension's merged result in turn) that `buildRegistry()`/`menu()`/`listViews()`/`formDescriptorFor()` simply read; extensions apply in registration order, after the base and after earlier modules' extensions. An extension targeting an unregistered path, an unknown field/target/id, a duplicate field name, or a malformed `move` (both or neither of `name`/`id`) throws, naming the module, path, and operation — registration-time, not render-time. `module.json` `depends` (threaded via `RegisterOptions.depends`, discovery-generated) drives BOTH the module registration order (`topoSortModules` — a real dependency-graph topological sort, name as tie-break, cycle ⇒ build error) and a `console.warn` when a module extends a path owned by a module absent from its own `depends`. See `docs/roadmaps/view-customization.md`. |
| Field widgets | `FieldDescriptor.widget` picks presentation per data type (`FIELD_WIDGETS` matrix, first entry = default): text `simple`/`long`/`phone` · number `float`/`int`/`percent`/`stars`/`phone` · boolean `switch`/`picture`/`signature` · selection `select` (only entry) · date/relation stock. `widgetOptions` tunes it (`{ max: 5 }`, `{ decimals: 0 }`, `{ base: 'percent' }`) — JSON only. Invalid pairs fail at `registry.register`, naming module/route/field. Numeric widgets format exclusively through `useNumberFormat()`. Boolean `picture`/`signature` are backed by the core picture service (field true ⇔ a picture exists on the `(entity, record, field)` anchor). `type: 'selection'` requires a non-empty `selection: { options: string[] }`; no `default` declared ⇒ the FIRST option. See `docs/roadmaps/field-widgets.md`. |
| Relation fields | `type: 'relation'` requires a `relation` block `{ entity, kind, labelField? ('name'), inverseField? (o2m), via? (m2m junction entity), viaFields? }`; the widget derives from the kind (`many2one`→search+wizard, `one2many`→read-only embedded grid, `many2many`→tag chips over junction rows). o2m/m2m fields are **virtual** — auto-stripped from commit payloads. Data path: **RelationOps**, entity-generic Server Actions Go authorizes every query/link from. **Create-from-search:** m2o/m2m dropdowns list up to 6 results plus a 7th "Create a new <entity>" line (the o2m grid gets the same line under it), opening a creation dialog over the target entity's own registered form descriptor bound to `RelationOps.create`. |
| Field behaviors | `FieldDescriptor.compute` names a function registered via `registerFieldFunction({ entity, name, depends, handler })` (a NAME, never a function); `registerOnChange({ entity, name, onChange, handler })` patches the draft when listed fields change. on_change fires only on genuine edits and once, at seed, for a brand-new record with no id — loading an existing record or the post-commit reconcile runs a compute-only pass instead, so a suggestion never overwrites a value the user set or that was just saved. `store: false` = display-only, stripped from commit payloads. `FieldDescriptor.default` seeds fields the record lacks: a JSON literal or a registered function name; omitted ⇒ the type's zero default. DB indexes stay a **Go model** concern (`db:"col,index=gin"`). |
| Data + mutations | **Reads** server-side via the server `ApiClient` (Next Data Cache, `tags:[entity]`). **Writes** via Server Actions that call Go then `revalidateTag(entity)` — no client→Go calls. |
| **Module FE contract** | `module.json.static_files.views` lists `.ts` files under the module's `views/`. Each file default-exports a **`FrontModule`** ( `{ name; routes:[{ path; descriptor: ViewDescriptor; permission? }]; extends?: ViewExtension[] }` ) registered with the engine. A module contributes **descriptors only** — the engine derives the server loader, the Zustand store, and the renderer; a module with NO routes of its own (`routes: []`) may still contribute by **extending** another (or its own) already-registered route — `core/modules/crminheritdemo/views/CrmInheritViews.ts` is the reference example. Modules import the engine from `@eerp/core-front`. `module.json.app_mode: true` additionally presents the module as an application (landing-menu tile); default = routes only, no tile — meaningless for a routes-less extension-only module. |
| **i18n contract** | Gettext, **source string = msgid**: components call `useT()` / `t('Save')`; untranslated strings render verbatim. A module ships translations in an **`i18n/` folder** next to its `module.json` — `<name>.pot` (declared source strings) + one `<locale>.po` per language (`fr.po` → locale `fr`); the shell's own chrome strings live in `apps/shell/i18n/`. Discovered with the modules at **build time** (no module.json field — the folder is the contract), parsed to JSON, registered into the shared `translationRegistry`; catalogs of the same locale **merge across modules** (last registered wins per msgid). The user's language choice + enabled translations persist client-side in `useI18nStore` (Settings → Translations). Settings → Translations also **exports** one drop-in `.po` per module for a chosen target language (every translatable msgid, existing msgstrs pre-filled, blanks otherwise — `renderModulePo`). No plurals/msgctxt (such entries are skipped). |

## Module discovery (build-time, shared config)

At **build time** the frontend reads the **shared `eerp-config.json` at the repo root** (`EERP/` — the
same file the Go backend uses) and walks each path in its `module_root` array. For each it finds
`module.json`, reads `static_files.views`, and resolves each to `<module_dir>/views/<file>`. Reusing
the backend config keeps a single source of truth for module roots. The read happens **at build time
only** — the running frontend service never reads the backend's config or filesystem at runtime, so
the BFF boundary still holds.

The same walk discovers each module's **`i18n/` folder** (if any): every `<locale>.po` is parsed to
JSON at build time and written into a generated manifest that registers it with the engine's
`translationRegistry` — the browser never ships a gettext parser. Adding a language to a module is
dropping a `.po` file in its `i18n/` folder and rebuilding; no declaration anywhere else.

**Dependency order (`depends`):** discovery registers modules in `module.json` `depends` topological
order (`topoSortModules` in `module-discovery.mjs` — name as tie-break; a cycle is a build error naming
the chain) — the same field name the Go loader reads, so one `module.json` declares the relationship
for both sides. This is what makes view extensions safe: a module's `extends` always finds its target
already registered, because discovery guarantees the base module registers first. `depends` also rides
into the generated `moduleRegistry.register(mod, { depends: [...] })` call, so the registry can warn
(not throw) when a module extends a path owned by a module it doesn't declare depending on.

## State model (server vs client)

- **Server owns:** data fetching, the Next Data Cache, the session (httpOnly cookie → identity
  resolved server-side), and authorization.
- **Client (Zustand) owns:** per-view interaction stores seeded from server `initialData` (records,
  selected, draft, dirty, expanded); a `useSessionStore` (`persist`) mirroring identity/permissions
  for UI gating; a `useUiStore` (`persist`) for theme/sidebar/last-route; a `useI18nStore`
  (`persist`) for the active language + enabled translations. No `useSyncExternalStore`
  controller layer.
- **Mutations:** Server Actions → Go → `revalidateTag` → server re-render. The client store updates
  optimistically, then reconciles with the revalidated server data.

## Testing

Every file ships with tests. Unit tests mock `ApiClient`/Server Actions (no network). Integration
tests run against MSW or a live backend, are named `*.integration.test.ts`, and are skipped unless
`TEST_API_BASE` is set.
