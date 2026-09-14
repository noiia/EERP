# ADR-006: Runtime-configurable view fields (Kanban/Calendar)

**Status:** Accepted

## Context

`docs/roadmaps/list-view-modes.md` adds a display-mode switcher to every `tree`
(list) view: `List | Kanban | Calendar | Graph`. Kanban needs to know which field
holds a record's status (to become its columns); Calendar needs to know which
field holds a date (to position records on a grid). Both are per-entity choices —
`crm`'s status field is `status`, another entity's might be `stage` or nothing at
all.

Every other per-field concern already living in this codebase — `widget`,
`states`, `compute`, `default`, `relation` — is something a **module author**
commits in a `FrontModule`'s descriptor (`docs/roadmaps/field-widgets.md`,
`docs/roadmaps/view-customization.md`). ADR-005 went further and made even
*reshaping another module's view* a build-time, developer-authored concern
(`ViewExtension`, resolved at registration). The reflex, following that
precedent, would be to add `ViewDescriptor.kanbanStatusField?: string` and
`calendarDateField?: string` next to `formPath`/`createPermission`.

That reflex is wrong here, and this ADR exists to say why — and to bound the
exception so it doesn't become precedent for moving other descriptor concerns
into runtime config.

## Decision

### Kanban/Calendar field choice is workspace admin state, not descriptor data

Unlike `widget` or `states`, which encode something true about the *data
model* (a boolean is naturally a switch; a comment is naturally hidden while a
deal is incoming) and therefore belong with the module that defines the
field, "which field is the Kanban column" is a **presentation preference an
administrator makes after the module ships**, with no natural single right
answer, changeable without a rebuild or a deploy. Two workspaces running the
identical `crm` module might reasonably choose different status fields to
kanban by (or none at all). That is the same shape of decision as
`i18n.default_locale` or `format.number` — both already live in
`app_settings`, edited from a Settings page, never in a descriptor — not the
shape of decision `widget` or `states` represent.

Concretely: `views.<entity>.fields` = `{ kanban_status_field, calendar_date_field
}` is a tenant-scoped `app_settings` key (`core/internal/settings`), read/written
through dedicated handlers `GET|PUT /api/v1/settings/views/:entity/fields`
(permission `settings:views:read|write`), the same pattern as the existing
`i18n`/`format` settings — not a new mechanism, an application of the existing
one to a new key.

### The frontend still sources the CHOICES from the descriptor, just not the CHOICE

Settings → Views does not ask an admin to type a field name. It reads the
already-registered `ViewDescriptor` for each entity (via
`moduleRegistry.buildRegistry()`, the same accessor the catch-all route uses)
and offers only that entity's `type: 'selection'` fields as Kanban candidates
and `type: 'date'` fields as Calendar candidates. So the descriptor still owns
*what fields exist and what type they are* — the developer-authored, build-time
truth — while `app_settings` owns *which of those the workspace picked* — the
admin-authored, runtime truth. Neither side duplicates the other's job.

### Absence is a normal state, not an error

An entity with no configured Kanban/Calendar field is not a misconfiguration:
most entities will never need one. `GetViewFieldsSettings` returns
`{null, null, null}` for an unconfigured entity with a 200, not a 404, and the
frontend's mode switcher OMITS the corresponding button entirely rather than
rendering it disabled — see the amendment below for why this hardened from
"disabled with a tooltip" to "not rendered at all," and for Graph mode's own
`enable_graphs` gate (it used to be exempt from configuration; it no longer
is).

## Consequences

- `ViewDescriptor` gains **no new fields** for this feature. `FrontModule`
  authors write nothing to get Kanban/Calendar available on their entity — an
  admin configures it later, purely from Settings, purely at runtime.
- Two workspaces running the same module build can have different Kanban/
  Calendar configurations without a rebuild, redeploy, or descriptor diff —
  by design, since this is workspace state, not code.
- This is a **narrow, named exception**, not a new default. The next time a
  "should this be a descriptor field or app_settings?" question comes up, the
  test from this ADR is: does the value encode something true about the field
  itself (→ descriptor, developer-owned), or is it a workspace's presentation
  preference over an otherwise-unopinionated field (→ `app_settings`,
  admin-owned, this ADR's pattern)? Kanban/Calendar field choice is
  unambiguously the second case; most future concerns will still be the
  first, and belong back with `widget`/`states`/`compute` in the descriptor.
- Settings → Views has a dependency ADR-005's other settings pages don't:
  it must enumerate every registered module's tree-view descriptors, so it
  needs the same generated-manifest side-effect import
  (`import '@/generated/generated-modules'`) the catch-all route and the
  landing menu use, unlike Settings → Users, which declares its own
  descriptors and needs no cross-module registry read.

## Amendment (2026-08-13): module-declared defaults, hidden-not-disabled, Graph gets a gate

Three refinements, still within this ADR's own boundary (`app_settings` stays
the durable, admin-owned truth) rather than a reversal of it:

1. **`ViewDescriptor.viewModeDefaults?: { kanbanStatusField?; calendarDateField?;
   enableGraphs? }` — a module's own hardcoded BASELINE, not a new place the
   choice itself lives.** This looks like the exact reflex the original
   Decision rejected, so the distinction matters: `viewModeDefaults` is not
   "the Kanban field," it's "the Kanban field IF an admin hasn't picked one" —
   a starting point a workspace administrator can always override or revert,
   exactly like a form field's own `default` (`docs/roadmaps/field-widgets.md`)
   seeds a draft without becoming the value. The admin-owned override in
   `app_settings` still wins whenever it's non-null; `effectiveViewFields`
   (`api/view-fields.ts`) is the one function that resolves "default, then
   override" into what a renderer actually acts on. What changed is only that
   "no admin has opinion yet" no longer has to mean "disabled" — a module MAY
   ship a sensible starting point (e.g. a CRM's `status` field as its own
   Kanban column) without forcing every workspace to configure it by hand
   before the mode is even visible.
2. **Kanban/Calendar/Graph are hidden, not disabled, when unavailable.** The
   original "disabled button + tooltip" affordance implied "you could turn
   this on right here"; in practice turning it on always meant leaving the
   view for Settings → Views. `DisplayModeSwitcher` now renders only the modes
   `availableDisplayModes` reports true for — a mode with nothing configured
   (by the module OR the admin) simply isn't a button, mirroring how the
   Create button itself only appears when `createPermission` is granted
   rather than rendering disabled.
3. **Graph gets `enable_graphs`, the same override/default shape as the other
   two.** "An empty canvas needs no configuration" was true, but it also meant
   every entity's list view carried a Graph tab whether or not that entity
   ever benefited from one. `enable_graphs` (nullable bool, same
   `views.<entity>.fields` key) makes Graph an opt-in mode like Kanban/
   Calendar, with the same module-default/admin-override/revert shape as the
   other two.
4. **Settings → Views gained a "revert to module settings" action.** Once a
   field/flag has a module default, Settings → Views warns before saving a
   value that diverges from it ("this is set by the module — overriding it
   only affects this workspace") and, once overridden, offers a one-click
   revert (clears just the overridden fields the module actually defaults,
   leaving any OTHER admin choice on that row untouched) — `ViewsSettings.tsx`.
   Go itself stores only the override (`viewFieldsConfig`, unchanged shape
   plus `EnableGraphs *bool`); it never sees a descriptor, so "revert" is
   simply nulling the override back out, resolved to "inherit the default"
   client-side, same posture `PictureSizeKey`/`ModulePictureSizeKey`'s
   Base/module cascade already established for "absence means inherit, no
   separate delete endpoint needed."

None of this changes the core test from the original Decision: an admin's
choice, once made, is still the one that wins, still lives in `app_settings`,
still edited without a rebuild. What's new is that a module may now suggest a
starting point instead of forcing every workspace to start from nothing.

## Reference implementation

`core/internal/settings` (`GetViewFieldsSettings`/`PutViewFieldsSettings`, key
`views.<entity>.fields`, now also `EnableGraphs`);
`core-front/packages/core-front/src/api/view-fields.ts` (`ViewFieldsConfig`,
`ViewModeDefaults`, `effectiveViewFields`, `DisplayMode`,
`availableDisplayModes`); `ViewDescriptor.viewModeDefaults`
(`core-front/packages/core-front/src/views/descriptor.ts`); the `TreeRenderer`
mode switcher and `useUiStore.viewMode`
(`core-front/packages/core-front/src/views/renderers.tsx`, `ui-store.ts`);
`apps/shell/src/components/ViewsSettings.tsx` (the admin UI — warning dialog +
revert button), rendered per-module from
`apps/shell/app/settings/apps/[module]/page.tsx`, sourcing each entity's field
choices AND its module defaults from `apps/shell/app/settings/views/registry.ts`'s
`treeViewEntities()` (`moduleRegistry.buildRegistry()`).
