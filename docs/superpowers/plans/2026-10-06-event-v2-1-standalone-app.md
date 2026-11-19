# Event v2 · SP1 — Standalone Event app — Implementation Plan

**Spec:** [Event v2 overview § SP1](../specs/2026-10-06-event-v2-overview.md#sp1-standalone-event-app)

**Goal:** the `event` module becomes an application of its own (launcher tile, `/event…` routes,
its own top-bar menus) instead of a submenu of Website.

**Global constraints:** frontend descriptors + `module.json` + docs only; Go routes and
permissions are unchanged; no redirects from the old `/website/events…` pages.

## File structure

- `core/modules/event/module.json` — `app_mode: true`, `menu_icon: calendar-days`
- `core/modules/event/views/EventViews.ts` — routes, list views, menus
- `core/modules/event/views/EventViews.test.ts` — route/menu assertions
- `CLAUDE.md`, `core-front/CLAUDE.md` (if it names the event menus) — docs

### Task 1: Routes and menus

- [x] **Step 1: Failing test** — `EventViews.test.ts`: every route starts with `/event`; tree
  routes `/event`, `/event/sessions`, `/event/bookings`, `/event/availability` exist with form
  routes `…/:id`; `ModuleRegistry.headerMenus()` for `event` lists Events, Sessions, Bookings,
  then Configuration containing Settings + Availability; no `website` header menu named `events`;
  every o2m `formPath` on the event form starts with `/event/`; `menu()` gives `event` a tile.
- [x] **Step 2: Run, verify it fails** — `pnpm vitest run` in `core/modules/event`.
- [x] **Step 3: Implement** — move every route to `/event…`; add `tree` views for
  `event_session` (event, start, end, capacity, seats taken) and `event_availability` (event,
  weekday, from, to; `hideFromTopBar`); `navLabel` Events / Sessions / Bookings; replace
  `registerHeaderMenu('website', 'events', …)` with
  `registerHeaderMenu('event', 'configuration', { Availability })`; o2m `formPath`s to the new
  form routes; `module.json` app mode + icon.
- [x] **Step 4: Run tests, typecheck, regenerate modules** — vitest, `tsc`, shell module
  discovery picks up the app tile.
- [ ] **Step 5: Commit** — `feat(event): standalone Event app with its own routes and menus`

### Task 2: Documentation

- [x] **Step 1:** update `CLAUDE.md`'s `core/modules/event` entry (`app_mode: true`, ERP routes
  under `/event`) and any frontend doc naming the Website → Events menu.
- [ ] **Step 2:** tick this plan; commit `docs(event): standalone Event app`.
