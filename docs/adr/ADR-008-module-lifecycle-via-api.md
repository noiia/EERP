# ADR-008: Module lifecycle managed via API

**Status:** Accepted

## Context

`docs/roadmaps/app-store.md` gives every workspace a self-service view over
its installed modules: a catalog page listing them, a form per module, and a
way to turn one on or off without SSHing in and hand-editing a `module.json`.
Four phases built this — a Go management API over `module.json` (Phase 1),
two small engine gaps the App Store's UI needed generically (Phase 2), the
`appstore` module itself (Phase 3), and the Activate/Deactivate wiring
(Phase 4) — and along the way several decisions were made that cut against
the codebase's usual defaults. This ADR records why, so a future reader
doesn't mistake any of them for oversights.

## Decisions

### 1. File-write + restart, not hot reload — **superseded by [ADR-009](ADR-009-live-module-lifecycle.md)**

> This decision described the original (Phases 1-4) design and is kept below
> for historical context. It no longer reflects the current behavior:
> `PUT /api/v1/modules/:id` now flips a live, in-process gate immediately
> (`internal/module/runtime.go`'s `Registry.SetActive`) and only writes
> `module.json` afterward — no restart, no `requires_restart` field. See
> ADR-009 for the live-lifecycle design and why "hot reload" turned out to be
> smaller in scope than this decision originally assumed.

`Manager.Patch` (`core/internal/module/manager.go`) writes straight to the
module's `module.json` on disk and returns immediately — it does not
re-trigger `module.LoadModules()`, unload a WASM instance, or otherwise make
the change live. Every successful `PUT` response carries `requires_restart:
true` (`handler.go`'s `Update`), and the frontend surfaces that as a
persistent notice rather than pretending the toggle took effect.

Hot-reloading a WASM module mid-process — draining in-flight requests,
tearing down its Wasmtime instance, re-running its migration, re-registering
its routes — is real, general infrastructure work that belongs to the
module *loading* system (`internal/module/load.go`, `detector.go`), not to a
CRUD-shaped management API. The roadmap's own module-discovery story is
already versioned as v1 (build-time, current) → v2 (runtime registry,
deferred); hot reload is a v2-shaped feature and is deferred there rather
than bolted onto Phase 1's file store. Building it here would mean solving
it twice.

### 2. Raw-JSON patching, not a `types.Module` round-trip

`Manager` reads and writes `module.json` as a plain `map[string]any`
(`readModuleJSON`/`writeModuleJSON`), never deserializing into
`internal/types.Module`. `detector.go`'s typed, cached walk exists for a
different job — fast, repeated lookups during module loading — and
`types.Module` only knows the fields the loader needs. The App Store's
management API must round-trip *whatever keys a module.json actually has*,
including ones no Go type declares yet (`app_mode`, a module's own future
metadata) — a typed struct would silently drop them on every write. Raw-map
patching, field-whitelisted (`writableModuleFields`) rather than
struct-whitelisted, is the only way a `PUT` can touch exactly one key and
leave everything else on disk byte-for-byte equivalent (modulo
`encoding/json`'s own key-sorting and re-indentation, which is expected, not
a bug).

This is also why `Manager` is deliberately stateless — no snapshot cache
like `detector.go`'s — a `PUT` must always patch what's on disk *right now*,
never a cached view that a concurrent process (or a manual edit) has already
moved past.

### 3. Activation is a button, not a field

The form page at `/appstore/:id` (`core/modules/appstore/views/AppStoreViews.ts`)
declares every field `readOnly: true`, `active` and `app_mode` included. The
Activate/Deactivate control (`apps/shell/app/appstore/[id]/ActivateButton.tsx`)
is host chrome rendered beside the generic `EntityView`, never a field inside
it, with its **own** Server Action (`setModuleActive`,
`apps/shell/src/lib/module-actions.ts`) hitting `PUT /api/v1/modules/:id`
directly — the form's own commit path is never exercised, because a form
with no writable fields never dirties.

The reason isn't mechanical (a `switch` widget bound to `active` would work
fine); it's that flipping a module's active flag is not "editing a record."
It has side effects a plain field commit doesn't: it needs the
self-protection check (below), it needs to explain that the change is
pending a restart, and it needs to badge the catalog row so a workspace
admin can see what they just touched even after navigating away. A button
with its own action makes room for exactly that; a form field would need to
grow all of it as special-cased commit behavior, which is a worse fit for
what `LayoutForm`'s save path is for. `CreateBar` already established the
precedent of write affordances living beside the generic form/tree view
rather than inside its store — this reuses that posture.

### 4. `app_mode` stopped being writable

`writableModuleFields` (`manager.go`) whitelists exactly `{"active": true}`.
Early drafts of the roadmap considered letting `app_mode` and `display_name`
be edited from the App Store too, since they're both plain `module.json`
keys. That was narrowed to `active` alone: every other key is *deployment
metadata* — how a module presents once compiled in (`app_mode`), what
version was compiled (`version`), which files the frontend/backend load
(`static_files`) — decided when the module is authored or deployed, not
something a workspace admin should be able to drift from the code that was
actually shipped. `active` is the one exception because "is this module
running" is squarely operational state, the same kind of on/off a workspace
admin already expects to control (a feature flag, not a code change). Adding
more writable fields later is possible, but each one needs its own argument
for why it's operational rather than deployment metadata — the whitelist
being a single-entry map is the enforcement mechanism, not an oversight to
widen casually.

### 5. Self-protection is server-enforced, not just a UI hint

`applyPatch` (`manager.go`) refuses `active: false` for the `appstore` module
itself with a `ValidationError`, regardless of what the frontend sends. The
`ActivateButton` also disables itself with a tooltip for this exact case —
but that's a UX courtesy, not the enforcement boundary. A REST client hitting
the endpoint directly, or a future caller that isn't this button, still
can't brick the one module that lets you turn modules back on.

### 6. Views/Reports data comes from the frontend's own registry, not Go

The App Store's form has a notebook with a "Views" tab (a table of every
view a module created or edited) and a "Reports" tab (currently inert,
reserved for a future roadmap). Both are populated entirely client/server-side
in the frontend — `core-front/apps/shell/app/appstore/[id]/module-views.ts`'s
`moduleViewRows()` reads `moduleRegistry.buildRegistry()` (which route a
module registered, i.e. "Created") and the new `moduleRegistry.extendedPaths()`
(which routes a module's own `extends` targets, i.e. "Edited"). Go never sees
this data; there's no new endpoint for it.

The reason: "which views does module X own or touch" is answered entirely
by facts the frontend's `ModuleRegistry` already computes at registration
time — it's the one place that has already resolved every `FrontModule` and
every `ViewExtension` for the whole running frontend. Go's `module.json`
walk has no concept of a "view" at all; recomputing this server-side would
mean either teaching Go to parse TypeScript view files (absurd) or
duplicating the registry's own resolution logic in a second language.
Reusing the frontend's existing registry is not a shortcut, it's the only
place this information actually lives.

## Consequences

- ~~Deactivating a module from the App Store changes `module.json` on disk
  immediately, but the module keeps running... until the next
  `make rebuild-and-run`~~ — **superseded by ADR-009**: deactivation now
  gates the module's routes live, in the same request cycle as the `PUT`.
- The App Store's own `active` flag has one extra guard the generic
  whitelist doesn't: it can be flipped to `false` for any *other* module by
  any caller with `modules:modules:write`, but never for itself.
- Adding a new writable `module.json` field later means adding it to
  `writableModuleFields` **and** writing the argument for why it's
  operational state rather than deployment metadata (Decision 4) — this ADR
  is where that argument should be recorded or contested.
- ~~Hot reload... deferred to the v2 runtime module registry~~ —
  **superseded by ADR-009**: activate/deactivate/reload are live for every
  module already known to `module_root` at the last build; only a module
  folder that didn't exist at that build still needs one rebuild to be
  discovered at all (true zero-build hot-*install* of unseen code remains
  the deferred v2 bundle-federation project). A real Reports page is still
  out of scope, deferred to its own future roadmap once there's real
  reporting data to show — the "Views" tab and the inert "Reports" tab both
  exist now so the notebook shape doesn't need to change when Reports
  eventually ships.

## Reference implementation

`core/internal/module/manager.go` (`Manager`, `writableModuleFields`,
`applyPatch`, `appstoreModuleName`), `handler.go` (`Handler`, the
`requires_restart` response field); `core/modules/appstore/views/AppStoreViews.ts`
(the read-only form descriptor, the Views/Reports notebook pages);
`core-front/apps/shell/app/appstore/[id]/ActivateButton.tsx` +
`src/lib/module-actions.ts` (the button's own write path, optimistic update,
revert-and-`ErrorAlert`); `core-front/apps/shell/app/appstore/[id]/module-views.ts`
(`moduleViewRows`, reading `moduleRegistry.buildRegistry()` +
`extendedPaths()`); `core-front/packages/core-front/src/views/recently-changed-store.ts`
(the session-only "badge this row" marker). See `docs/roadmaps/app-store.md`
for the full phase-by-phase build log and implementation notes.
