# ADR-011: Form actions menu — default form chrome for custom actions

**Status:** Accepted

## Context

`ReportExportButton` (`docs/adr/ADR-010`, `docs/roadmaps/pdf-reports.md` Phase 4) was the
only way a module could hang a custom action off a form: the catch-all
(`apps/shell/app/[...module]/page.tsx`) special-cased it directly — `viewType === 'form'` +
`moduleRegistry.reportForEntity(entity)` resolving a `ReportDescriptor` was the one and only
condition that made a button appear next to the page title. That doesn't generalize: a
"Send by email," "Duplicate," or "Mark as paid" action would each need its own bespoke
catch-all special case, one per feature, forever growing a component that is supposed to stay
generic across every module.

Meanwhile the page title itself (`<Typography variant="h4">` in the same row) was redundant
on a form specifically: the default form anatomy (`docs/adr/ADR-007`) already promotes the
record's own name-like field into a large title (`FORM_HEADER_ID`), so a form showed its
title twice — once as page chrome, once as the first field.

## Decision

### 1. One generic options menu, declared as data, not one bespoke button per feature

`ViewDescriptor.actions?: MenuNode[]` (`views/descriptor.ts`) is a small recursive tree:

```ts
type MenuNode =
  | { kind: 'action'; label: string; action: string }
  | { kind: 'submenu'; label: string; children: MenuNode[] }
```

Same "descriptors cross the RSC boundary as props" rule `compute`/`on_change` already
follow (`docs/roadmaps/field-widgets.md`, Phase 2): an action leaf names its handler by
NAME, never a function reference. `registerMenuAction({ entity, name, handler })`
(`views/menu-actions.ts`) is where a module's views file registers the actual handler, at
import time — mirroring `registerFieldFunction`/`registerOnChange` exactly, down to the
registry shape and the "entity mismatch fails at registration, not at click" validation
(`validateMenuActions`, wired into `registry.ts`'s `validateDescriptor` alongside the
existing widget/catalog/layout checks).

This makes "add a custom form action" a two-line addition to a module's own views file —
no catch-all change, no new special case — for ANY action, printing included. Printing is
not a first-class concept the menu knows about; it is simply the first handler a module
happened to register, calling the engine's `exportReportPDF(reportName, recordId)` (the
`report-export.ts` extraction of `ReportExportButton`'s old fetch-then-`window.open` body).

### 2. The button is default chrome, not an opt-in per module

`FormActionsMenu` renders unconditionally for every `viewType: 'form'` route — the same
"the engine always provides this structural piece" posture `CreateBar` already takes for
tree views (`core-front/CLAUDE.md`'s Create-affordance row). A descriptor with no `actions`
still gets the button, just disabled (`actions.length === 0`), rather than the catch-all
deciding per-descriptor whether the button exists at all. This was a deliberate simplicity
trade: a disabled, empty options button on most forms today is a smaller cost than
re-introducing a conditional-rendering special case at the one place (the catch-all) this
whole feature exists to keep generic.

The button is also disabled on an unsaved (`recordId === 'new'`) draft — nothing registered
so far acts on a record before it exists, and the menu has no way to know in advance
whether a future action might want to (e.g. "Save and print" is not something the current
handler contract expresses; it would need its own design if requested).

### 3. The page title is dropped from forms; the button takes its exact spot

`apps/shell/app/[...module]/page.tsx`'s title row now branches on `viewType === 'form'`:
forms render `<FormActionsMenu>` where the `<Typography variant="h4">` used to sit; every
other view type is unchanged (tree/dashboard/catalog keep the title, and tree additionally
keeps `CreateBar` on the same row). No new row, no new layout primitive — the options
button is a straight swap into chrome that already existed.

### 4. Nesting is a real MUI submenu, not a flattened list

A `submenu` node renders as a `MenuItem` that opens a second, right-anchored MUI `Menu` on
click (`form-actions-menu.tsx`'s `MenuNodeItem`, recursing on its own `children`) — closing
the root menu unmounts every open submenu automatically (MUI's `Menu` doesn't keep its
Portal content mounted while `open={false}`), so there is no explicit "close all submenus"
bookkeeping to get wrong. Icons (`MoreVertIcon`, `ChevronRightIcon`) are inlined `SvgIcon`
paths, not an `@mui/icons-material` dependency — the same call `relation-widgets.tsx`'s
`LinkIcon` and `picture-widgets.tsx`'s `DownloadIcon`/`CloseIcon` already made: one or two
icons don't justify a new package the engine doesn't otherwise need.

## Consequences

- `ReportExportButton` (component + test) is deleted outright — every entity that wants a
  print trigger now registers a menu action instead. `crm.statement` currently has no menu
  entry (`CrmViews.ts` wasn't touched by this change) and is reachable only by calling the
  report route directly until a future change adds one, the same way `sale.invoice` does
  (`core/modules/sale/views/SaleViews.ts`).
- `ModuleRegistry.reportForEntity` stays in the registry (still tested,
  `registry.test.ts`) as a general "does this entity have a report" query — it's simply no
  longer called from the catch-all, since printing is no longer auto-wired per entity.
- A module wanting a form action must both declare the `MenuNode` (data) and register its
  handler (code) — two places, on purpose, mirroring `compute`'s existing split; a
  descriptor naming an unregistered action, or one registered under a different entity,
  fails at module registration with the offending name, never silently at click time.
- No per-action permission gating exists yet (unlike `CreateBar`/the old
  `ReportExportButton`, both gated on a declared permission string) — every action on a
  form a user can already open is visible in the menu. Reachable data is unchanged (the
  handler still goes through the same authorized BFF/Go paths), so this is a UI-affordance
  gap, not a security one; add a `permission?` field to `MenuActionNode` if/when a module
  needs an action hidden from part of its own audience.

## Reference implementation

`core/modules/sale` (`module.go`'s `Invoice` entity, `views/SaleViews.ts`) is the first —
and, so far, only — consumer: its form declares one `Print` submenu holding one `Invoice`
leaf, whose registered handler is a one-line call to `exportReportPDF('sale.invoice',
recordId)`.
