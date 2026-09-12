# ADR-007: Default form anatomy — synthesized header, columns, notebook

**Status:** Accepted (header/columns implemented in Phase 3, the notebook node and its
default Settings page in Phase 4 — both of `docs/roadmaps/responsive-displays.md`; only
runtime, per-record notebook pages remain forward-looking, tracked below as Phase 5)

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
  resolved — `insertAt`'s target search already walks the whole tree recursively — but
  since `'name'` became the title field living inside `__form_header`, `'email'` landed
  as a sibling THERE, joining the header instead of the flat body it used to join: a
  real, visible consequence (a THREE-item, briefly crowded header at phone width) of a
  `move`'s anchor field moving out from under it as the default anatomy changed. Fixed
  in Phase 4 (`docs/roadmaps/responsive-displays.md`) by retargeting the op onto a field
  under the module's OWN control instead — `{ target: 'date', position: 'after' }`,
  `'date'` being this same module's own `addField` — landing `email` in
  `__form_columns` next to it, and returning the header to its intended two items. The
  general lesson this ADR keeps: an extension anchored on a field it does not own can
  have its target's home change under it when the default anatomy evolves; anchoring on
  a field the SAME extension controls is more future-proof. Pinned by
  `core/modules/crminheritdemo/views/CrmInheritViews.test.ts` (header is exactly
  `['picture', 'name']`; `email` sits immediately after `date` in `__form_columns`).

No new extension operation was needed. This is the point of `LayoutNode.id` existing at
registration-time already ([ADR-005](ADR-005-frontend-view-inheritance.md)): a
synthesized node is addressable by the same mechanism as a hand-authored one.

### 3. Runtime notebook pages will be per-record DATA — a third category alongside descriptor and `app_settings`

(Accepted here; implemented for the DECLARED half in Phase 4 — see decisions 5–6 below —
with the RUNTIME half, a user's own per-record pages, still forward-looking as Phase 5 of
`docs/roadmaps/responsive-displays.md`.) The notebook's declared pages (a `page`
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

### 5. The notebook is two new layout-tree node kinds, not a new extension operation

`{ kind: 'notebook', children }` and `{ kind: 'page', title, children }` are ordinary
`LayoutContainerNode`s — no new TypeScript interface — with `normalizeLayout` enforcing
the structural rules a hand-authored layout must follow exactly as strictly as a
synthesized one: a `page` is legal only as a direct child of a `notebook` (never
top-level, never nested in a `group`/`row`/`section`), every `page` declares a `title`
(it doubles as the tab label — a titleless page is a registration error, not a blank
tab), a `notebook`'s children are ALL `page`s, and at most one `notebook` exists per
layout (v1). Because a page is just a node with an `id`, the existing extension
operations already reach it — `addNode` targeting the notebook's id adds a page,
`addField` targeting a page (or a field inside one) drops a field on it, `move`
relocates fields between pages — so "a module creates a page as easily as it extends
any other view" needed zero new API surface; it is a direct consequence of decision 2
(stable, addressable ids) applied one level deeper. The synthesized default
(`FORM_NOTEBOOK_ID`, holding `PAGE_SETTINGS_ID` — title `'Settings'` — pre-loaded with
every `widget: 'long'` field) renders even with zero long fields, since it doubles as
where Phase 5's runtime, per-record pages will attach.

One real wrinkle this surfaced: `applyExtension`'s target-less `addField` used to assume
the last top-level node could always take a bare field child; appending the notebook
after `__form_columns` broke that assumption the moment a target-less op landed on a
`notebook` (a structural error, since a notebook can only contain pages). The fix is a
structural rule about the `notebook` KIND inside the generic engine's `insertAt` — scan
past any `notebook` for the nearest node that actually accepts a field — not a
form-specific carve-out, so it holds for any future container kind with the same
restriction. A second, separate rule (this one genuinely form/`long`-specific, and
therefore living in `applyExtension` rather than `insertAt`) sends a target-less
`widget: 'long'` `addField` onto the Settings page when one exists, ahead of the
generic fallback — proven by `crminheritdemo`'s `comment` field, which declares no
target or position at all and still lands on Settings.

### 6. Switching pages is client-only, ephemeral state — panels never unmount

The active tab is a plain `useState<number>` inside the notebook's own renderer, not
form-store state and not a route param: it is view state, not data, and it resets
freely on navigation with no persistence contract to honor. The panels themselves stay
mounted at all times — the inactive ones toggle the native `hidden` attribute, never a
conditional `{active === i && …}` unmount — so a field's mount effects (a picture
fetching its bytes, a relation widget querying its options) keep running on a page the
user isn't looking at, and a dirty, uncommitted edit on one page survives switching to
another and back, because nothing ever tore the component down. This costs a live
picture/relation subscription per hidden page at this scale, which is an accepted
trade against the alternative (losing in-progress edits or re-fetching on every tab
click) — revisit only if a form ships enough pages for that cost to matter. The one
sharp edge is the repo's own ResizeObserver rule (`docs/roadmaps/list-view-modes.md`
Pitfalls): anything measuring itself inside a `hidden` panel reads a `0×0` box until
revealed, so widgets rendering inside a page must tolerate that (the existing
`useElementSize` fallback already does).

## Consequences

- `ViewDescriptor.layout` gains no new required shape — an un-layouted form gets the new
  anatomy for free; an explicit layout (at any view type) is untouched.
- `layoutFieldOrder`'s output for `tree`/`dashboard`/`kanban`/`calendar` consumers
  (DataGrid columns, Kanban/Calendar card fields) is provably unchanged — pinned by a
  test asserting flat declaration order survives for those view types with a
  picture+text field mix that WOULD trigger the new synthesis if it weren't
  `viewType`-gated.
- Extensions targeting a form view now resolve against a nested default instead of a
  flat one. Order-relative assertions anchored on a field the extension itself
  controls (`email` immediately after `crminheritdemo`'s own `date`) keep holding;
  structure-exact assertions, or ones anchored on a field whose CONTAINER can change
  out from under them as the default anatomy evolves (the original `email` before
  `name` — `name` moved into the header), do not, and should not — the new nesting is
  the intended change, not an implementation leak (see decision 2).
- The relation create-from-search wizard (`relation-widgets.tsx`), which reuses the
  exact same `LayoutForm` a target entity's form uses, automatically renders the SAME
  header/columns default the entity's real form does — single-column, because its
  dialog is narrower than `layout.formTwoColumnMinWidth` — with no wizard-specific code.
- The three-way split this ADR names — descriptor (build-time, developer-owned) /
  `app_settings` (workspace-wide, admin-owned, [ADR-006](ADR-006-runtime-configurable-view-fields.md))
  / record-anchored service data (per-record, user-owned, the pictures/notebook
  pattern) — is the reference answer for where a future "where does this new concern
  live" question should land.
- A form-view extension's target-less `addField` now has two fallback destinations
  instead of one: `__form_columns` normally, or the Settings page (when one exists) for
  a `widget: 'long'` field — `crminheritdemo`'s `comment` proves the latter with no
  target/position of its own. A module that wants its added field somewhere else must
  say so explicitly, same as before this ADR.
- A synthesized form always ships a notebook, even with zero long fields and zero
  module-added pages — it is empty chrome in that case, kept for a reason: it is where
  Phase 5's runtime, per-record pages attach, so the tab strip doesn't need to
  materialize out of nowhere the first time a user adds a page.

## Reference implementation

`core-front/packages/core-front/src/views/descriptor.ts` (`FORM_HEADER_ID`,
`FORM_COLUMNS_ID`, `FORM_NOTEBOOK_ID`, `PAGE_SETTINGS_ID`, `synthesizeFormLayout`, the
`LayoutContainerNode.columns` / `LayoutFieldNode.variant` hints, and `normalizeLayout`'s
`notebook`/`page` structural validation); `layout-renderer.tsx` (`TitleField`, the
container-query `columns` rendering, the header row's phone-safe exception, and the
`notebook` renderer — MUI `Tabs` + `hidden`-toggled, always-mounted panels); `renderers.tsx`'s
`FormRenderer` (the width cap removed); `tokens.ts` (`layout.formTwoColumnMinWidth`);
`registry/extensions.ts` (the form-view materialization falls out of `applyExtension`'s
existing `normalizeLayout` call; `insertAt`'s target-less path now skips past a
`notebook` node, and a target-less `widget: 'long'` `addField` prefers the Settings page
— decision 5); `core/modules/crminheritdemo/views/CrmInheritViews.test.ts` (the pinned
consequences of decisions 2 and 5 — the `move` landing inside the header, and `comment`
landing on Settings with zero extra wiring). The runtime, per-record half of decision 3
(a user's own pages) remains Phase 5 of `docs/roadmaps/responsive-displays.md`.
