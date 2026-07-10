# ADR-007: Default form anatomy — synthesized header, columns, notebook

**Status:** Accepted (header/columns implemented — Phase 3 of
`docs/roadmaps/responsive-displays.md`; the notebook part is accepted but not yet
implemented — Phase 4, tracked below as a forward reference)

## Context

Before this ADR, `FormRenderer` rendered every `viewType: 'form'` descriptor as one
capped-width (`layout.formMaxWidth`, 560px) column, and `normalizeLayout` — the single
place that resolves a descriptor's presentational structure
(`docs/roadmaps/view-customization.md`, Phase 1) — synthesized the SAME implicit
fallback for every view type: one untitled `group` wrapping every field in declaration
order. That fallback is what made the layout tree backward-compatible when it was
introduced: a descriptor written before it existed renders unchanged.

`docs/roadmaps/responsive-displays.md` asks for a fundamentally different default form
shape — a header (picture left, big title right), two responsive columns, and a
notebook of tabbed pages underneath — modeled on Odoo's form view, and asks for it to be
the shape every entity gets **without declaring anything**. That is a much bigger change
than adding a rendering option: it means the one fallback `normalizeLayout` has always
produced now needs to differ **by view type**, and the new fallback needs to compose with
everything already built on top of the layout tree — view extensions
([ADR-005](ADR-005-frontend-view-inheritance.md)), declarative field states, behaviors.

Three questions had to be answered before any code:

1. Does the new anatomy live in `descriptor.layout` (stored, like an explicit layout), or
   does it stay synthesized (computed, like the old fallback)?
2. Extensions ([ADR-005](ADR-005-frontend-view-inheritance.md)) resolve against
   `normalizeLayout`'s output — what happens to `crminheritdemo`'s existing ops, written
   against a flat form, once that output has structure?
3. Runtime, per-record notebook pages ("a user adds a Meeting Notes tab to *this*
   record") are neither build-time descriptor data nor workspace `app_settings`
   ([ADR-006](ADR-006-runtime-configurable-view-fields.md)) — what are they, and how does
   that boundary stay legible next to the other two?

## Decision

### 1. The anatomy is synthesized, exactly like the old fallback — never written to `descriptor.layout`

`normalizeLayout` keeps its existing contract (declared `layout`, validated, or a
computed default) and gains exactly one new branch: `viewType === 'form'` with no
declared `layout` now computes a **richer** default — a header row
(`__form_header`: the first `widget: 'picture'` boolean field, then the first `text`
field rendered big via a new `variant: 'title'` hint) followed by a two-column group
(`__form_columns`, a new `columns` hint) holding every other field, in declaration
order. Every other view type (`tree`, `dashboard`, and any future one) keeps the
original flat, untitled group, unchanged — this is a narrow, `viewType`-scoped addition
to an existing mechanism, not a new one, and it costs nothing for the views that don't
want it.

Nothing is ever written back to `descriptor.fields` or `descriptor.layout`. A module
that declares an explicit `layout` gets exactly what it declared, at any view type — it
has opted out of the default by definition, the same rule that already governed the
flat fallback.

### 2. The synthesized nodes carry stable, well-known ids — so extensions can target the default anatomy exactly like a hand-authored one

`FORM_HEADER_ID = '__form_header'` and `FORM_COLUMNS_ID = '__form_columns'` are exported
constants, not implementation details. `applyExtension` already normalizes the layout
before applying operations (materializing the flat implicit group when a base
descriptor declared none); for a form view it now materializes the RICHER default
first, so an extension's `addField`/`move`/`addNode` operations resolve against the
header/columns structure exactly as they resolved against the flat group before. Two
concrete consequences fall out of this, both intentional:

- A no-target `addField` (`position` defaults to `'last'`, `target` absent) lands as the
  last child of `__form_columns` — the last top-level container — instead of at the top
  level of a flat group. This is the literal "just add it, I don't care where" behavior
  from before, applied to the new shape.
- `crminheritdemo`'s pre-existing `{ op: 'move', name: 'email', target: 'name',
  position: 'before' }` (written years before this ADR, against a flat form) still
  resolves — `insertAt`'s target search already walks the whole tree recursively — but
  since `'name'` is now the title field living inside `__form_header`, `'email'` is
  inserted as a sibling THERE, joining the header, not the flat body it used to join.
  The relative order the extension actually cares about (`email` before `name`) is
  unchanged; WHERE that guarantee is satisfied moved, because the shape it targets
  moved. This is treated as the correct, expected consequence of changing the default
  anatomy, not a regression — it is pinned by a test in
  `core/modules/crminheritdemo/views/CrmInheritViews.test.ts` precisely so a future
  change to either the synthesis or the extension notices if the relationship breaks.

No new extension operation was needed. This is the point of `LayoutNode.id` existing at
registration-time already ([ADR-005](ADR-005-frontend-view-inheritance.md)): a
synthesized node is addressable by the same mechanism as a hand-authored one.

### 3. Runtime notebook pages will be per-record DATA — a third category alongside descriptor and `app_settings`

(Accepted here; implemented in Phase 5 of `docs/roadmaps/responsive-displays.md`, once
the notebook node itself lands in Phase 4.) The notebook's declared pages (a `page`
layout node inside a `notebook` node, holding fields) are descriptor structure, the same
category as everything else in the layout tree, and get there the same way — an
extension, or a hand-authored `layout`. A page a USER adds to one specific record at
runtime ("Meeting Notes" on this one crm row) is neither of the two categories this
codebase already has a home for:

- Not descriptor data ([ADR-005](ADR-005-frontend-view-inheritance.md)'s territory): it
  isn't build-time structure a module author commits, and it doesn't exist for every
  record of the entity, only the one the user added it to.
- Not workspace `app_settings` ([ADR-006](ADR-006-runtime-configurable-view-fields.md)'s
  territory): it isn't a tenant-wide admin preference either — two different `crm`
  records can have entirely different runtime pages.

It is **record-anchored content**, the same shape of thing the picture service already
represents (`internal/pictures/`: metadata keyed on `(tenant, table, record, field)`,
tenant-pinned dedicated routes off the generic CRUD surface, route-derived
permissions). `internal/notebook/` follows that exact template. This is a deliberate
third category, not a special case of the other two — a future "should this be a
descriptor field, `app_settings`, or per-record data?" question should ask: does it
exist for every record of the entity by construction (descriptor), is it one value the
whole tenant shares (`app_settings`), or does it vary per record at the user's own
discretion (this — record-anchored data, the pictures/notebook pattern)?

### 4. Two new JSON-only layout hints, not new widget types

`LayoutFieldNode.variant?: 'title'` and `LayoutContainerNode.columns?: number` are
rendering hints on the EXISTING node shapes, not a fourth node kind or a new widget.
`variant: 'title'` still dispatches to a real text input (a large, borderless-until-focus
`TextField` with the label as a placeholder) — required/disabled/error affordances all
still apply, because it is still the same field, restyled, never a different component
with its own validation story. `columns` renders as a CSS **container query** grid
(`container-type: inline-size` on a wrapper, `@container (min-width: …)` on the grid
itself), deliberately never a viewport media query: the identical `LayoutForm` renders
both the full-width form page and the relation create-wizard's ~552px dialog, and only
the dialog should ever collapse to one column — a viewport query cannot tell those two
render contexts apart, a container query naturally can.

## Consequences

- `ViewDescriptor.layout` gains no new required shape — an un-layouted form gets the new
  anatomy for free; an explicit layout (at any view type) is untouched.
- `layoutFieldOrder`'s output for `tree`/`dashboard`/`kanban`/`calendar` consumers
  (DataGrid columns, Kanban/Calendar card fields) is provably unchanged — pinned by a
  test asserting flat declaration order survives for those view types with a
  picture+text field mix that WOULD trigger the new synthesis if it weren't
  `viewType`-gated.
- Extensions targeting a form view now resolve against a nested default instead of a
  flat one. Existing order-relative assertions (`email` before `name`) keep holding;
  structure-exact assertions do not, and should not — the new nesting is the intended
  change, not an implementation leak.
- The relation create-from-search wizard (`relation-widgets.tsx`), which reuses the
  exact same `LayoutForm` a target entity's form uses, automatically renders the SAME
  header/columns default the entity's real form does — single-column, because its
  dialog is narrower than `layout.formTwoColumnMinWidth` — with no wizard-specific code.
- The three-way split this ADR names — descriptor (build-time, developer-owned) /
  `app_settings` (workspace-wide, admin-owned, [ADR-006](ADR-006-runtime-configurable-view-fields.md))
  / record-anchored service data (per-record, user-owned, the pictures/notebook
  pattern) — is the reference answer for where a future "where does this new concern
  live" question should land.

## Reference implementation

`core-front/packages/core-front/src/views/descriptor.ts` (`FORM_HEADER_ID`,
`FORM_COLUMNS_ID`, `synthesizeFormLayout`, the `LayoutContainerNode.columns` /
`LayoutFieldNode.variant` hints); `layout-renderer.tsx` (`TitleField`, the
container-query `columns` rendering, the header row's phone-safe exception);
`renderers.tsx`'s `FormRenderer` (the width cap removed); `tokens.ts`
(`layout.formTwoColumnMinWidth`); `registry/extensions.ts` (unchanged — the
form-view materialization falls out of `applyExtension`'s existing
`normalizeLayout` call); `core/modules/crminheritdemo/views/CrmInheritViews.test.ts`
(the pinned consequence of decision 2). The notebook/runtime-pages half of decision 3
lands in Phases 4–5 of `docs/roadmaps/responsive-displays.md`.
