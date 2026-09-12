# ADR-005: Frontend view inheritance

**Status:** Accepted

**Note on numbering:** ADR-003 (soft-delete by default) and ADR-004 (frontend framework:
SvelteKit CSR → React + Next.js App Router, RSC/SSR) are referenced throughout
`core-front/CLAUDE.md` and `CONVENTIONS.md` but were never captured as standalone files.
This is the first ADR actually committed to `docs/adr/`; a future pass should backfill
003–004 so the sequence is complete, not just cited.

## Context

The Go backend already had a working answer for "let one module extend another's shape
without editing it": `crminheritdemo` embeds `crm.CRM`, re-registers the `crm` table under
`orm.WithTableName("crm")`, and the generic CRUD API gains `date`/`comment` columns — the
`crm` module's own Go source is never touched. That pattern (declare, don't patch) is the
whole reason the ORM's `orm.Register[T](orm.WithTableName(...))` exists.

The frontend had no equivalent. `ViewDescriptor.fields` was a flat, closed array a module
declared once; nothing else could see or reshape it. So `crminheritdemo`'s extra columns
existed in the API but could never appear on the CRM form or list — the one place users
actually look — without editing `CrmViews.ts` directly. That breaks the module-isolation
promise in exactly the place it matters most, and it meant the backend's own showcase
module had no frontend at all (see `docs/roadmaps/view-customization.md`).

Three sub-questions had to be answered before any code:

1. **When does an extension apply — render time, or earlier?**
2. **How does an extension describe a change — component overrides, or something else?**
3. **What guarantees a base view exists before something tries to extend it?**

## Decision

### 1. Resolution happens once, at registration — never at render

`ModuleRegistry.register()` applies a module's `extends` immediately, merging the result
into a `resolvedRoutes: Map<path, RouteConfig>` the registry already needed for
`buildRegistry()`. Every accessor (`buildRegistry()`, `menu()`, `listViews()`,
`formDescriptorFor()`) reads that map directly — none of them, and none of the client
renderers (`FormRenderer`, `TreeRenderer`, the relation create-from-search wizard), have
any awareness that `extends` exists. A renderer receives one plain, already-merged
`ViewDescriptor` and walks it exactly like it always has.

This mirrors the Go loader's own posture: `LoadModules` resolves the module graph once at
startup, not per-request. Resolving per-render instead would mean re-running every
extension's operations on every page load (wasted work, since the operations are pure and
deterministic) and — worse — would leak the *concept* of inheritance into rendering code
that has no business knowing about it. The refactor cost of Phase 3 stayed entirely inside
`src/registry/`; Phases 1–2 (the layout tree, declarative states) needed zero changes to
support it, because they'd already established "renderers walk a normalized descriptor,
never `descriptor.fields` directly" as the one entry point.

### 2. Extensions are serializable operations, not component overrides

The alternative most frameworks reach for — override a component, wrap it, or monkey-patch
a render function — was never on the table here for the same reason `FieldDescriptor`
can't carry a `compute` function directly: descriptors cross the RSC boundary as props from
a Server Component to a Client Component, and React Server Components can only pass
JSON-serializable data across that boundary. A function reference simply cannot survive the
trip. This was already the standing rule for `compute`/`on_change` (registered by NAME, not
passed as a closure) and for `states.visible`/`readOnly`/`required` (a `Condition` object,
not a predicate function); view extensions are the same constraint applied one level up, to
the *shape* of the view instead of one field's value.

Odoo solved the identical problem for server-rendered XML views: `<xpath expr="//field[@name='email']"
position="after">…</xpath>` is data an interpreter walks, not code that runs. `Operation`
(`addField` / `removeField` / `setField` / `move` / `addNode` / `setDescriptor`) is that
same idea in typed TS instead of XPath — the anchor is a field `name` or an explicit layout
node `id` (no XPath expression language to parse or sandbox), and `applyExtension()` is the
interpreter: a pure function, `(descriptor, operations) → descriptor`, fully unit-testable
without a DOM, a registry, or a running app.

**Why this shape stays cheap even as the operation set grows:** every operation is a plain
tagged record (`{ op: 'addField', ... }`); adding a new operation kind is a new union
member and a new `case` in `applyExtension`'s switch, not a new escape hatch into arbitrary
code. The registry's `register()` step still validates the *result* through the same
`validateDescriptorWidgets` / `buildBehaviorPlan` / `normalizeLayout` gate a base descriptor
goes through — an extension that produces a broken field or a dangling layout reference
fails exactly where a hand-written bug would, at registration, naming the module and the
operation.

### 3. Dependency-ordered registration is what makes "already registered" true

An extension's very first requirement — "the path I'm targeting must already resolve to
something" — only holds if modules register in the right order. Sorting modules
alphabetically (the pre-Phase-3 behavior) made `crminheritdemo` register after `crm` *by
coincidence of spelling*, which the roadmap calls out by name as a landmine: a module named
`aaa-something` extending `crm` would have silently failed to find its target.

`module.json`'s `depends` field already existed — the Go loader reads it — but nothing on
the frontend acted on it. `topoSortModules` (in `module-discovery.mjs`) computes a real
topological order from that graph (name as tie-break for determinism; a cycle is a build
error naming the chain), and the generated manifest registers modules in that order. This
turns "the target is already registered" from a lucky accident into a build-time
invariant — the same category of guarantee dependency-ordered service startup gives the Go
side. A module that extends a path without declaring the owning module in its own
`depends` still *works* (registration order already guarantees the target exists) but gets
a `console.warn` naming the gap — a hygiene signal, not a hard gate, because the ordering
that makes it safe doesn't actually require the declaration to be honest.

## Consequences

- Renderers, stores, and loaders stayed untouched by Phase 3 — the entire feature lives in
  `src/registry/`, which is exactly what "resolve once, render a plain descriptor forever
  after" was meant to buy.
- A base module's route path is now part of its public contract: renaming `/crm/:id`
  breaks every extension targeting it, loudly, at the extending module's registration —
  the same blast radius a breaking API change has, which is the correct severity.
- `applyExtension` had to define its own precise semantics for cases the roadmap's
  contracts table left implicit — most notably, a target-less `addField`/`move` inserts
  into the last top-level container's children (not as a stray top-level sibling), and
  `addNode` extracts its referenced fields from their current position before re-homing
  them (so wrapping already-placed fields into a new row doesn't produce a duplicate-field
  validation error). Both are documented on the operation types themselves and pinned by
  tests in `extensions.test.ts`.
- The "depends-coverage" warning could not live in the static discovery script as literally
  specified (a codegen-time warning) because `module-discovery.mjs` never executes a
  module's TypeScript — it only writes `import` statements for the bundler to resolve. The
  check moved to `ModuleRegistry.register()`, which has full runtime access to `.extends`
  and already knows which module owns which path. The observable developer experience (a
  warning during `next dev`/`next build`) is unchanged; only the implementation layer moved
  from "codegen" to "registration".

## Reference implementation

`core/modules/crminheritdemo` is the proof end to end: its Go side (`module.go`,
`internal/crm.go`) adds `date`/`comment` columns to the `crm` table without touching
`core/modules/crm`; its frontend side (`views/CrmInheritViews.ts`) extends `/crm/:id` and
`/crm/list` — adding those same two fields, reordering `email` before `name`, and hiding
`comment` while `status` is `incoming` — without touching `core/modules/crm/views/CrmViews.ts`.
Deactivating `crminheritdemo` (`module.json` `active: false`) and rebuilding removes both
the Go columns' API surface and the frontend extension, restoring the stock CRM view.
