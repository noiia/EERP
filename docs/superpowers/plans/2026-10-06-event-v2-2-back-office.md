# Event v2 · SP2 — Back office — Implementation Plan

**Spec:** [Event v2 overview § SP2](../specs/2026-10-06-event-v2-overview.md#sp2-back-office)

**Goal:** staff run events from the Event app: check attendees in, see sessions and bookings on
calendars and kanbans, and land on a dashboard.

**Global constraints:** seats are only ever written by the booking service (ADR-026); an
`attended`/`no_show` booking keeps its seats (every capacity count becomes "not cancelled");
view presets are seeded only where absent, never overwriting an admin's choice.

## File structure

- `core/modules/event/models.go` — `BookingAttended`, `BookingNoShow`, `EventBooking.StartsAt`
- `core/modules/event/booking.go` — `starts_at` on book; capacity counts exclude only cancelled;
  `SetAttendance`; cancel refuses checked-in bookings; `SyncSessionStart`
- `core/modules/event/handler.go` — `StaffUpdate` accepts attended/no_show;
  `GuardSessionUpdate` re-syncs bookings after a successful update; `ErrState` → 409
- `core/modules/event/module.go` — slot index on held seats, `starts_at` backfill/resync, graph
  presets (`presets.go`); kanban/calendar defaults are descriptor `viewModeDefaults` instead of
  seeded `views.<entity>.fields`
- `core/modules/event/views/EventViews.ts` — Check in / No show buttons, statuses, `starts_at`

### Task 1: Statuses, check-in and `starts_at` (Go)

- [x] **Step 1: Failing tests** (`booking_test.go`): a booking stores `starts_at` (session start
  / slot start); check-in before start − 1 h is a 400, after it works and keeps seats; an
  attended booking can't be cancelled (`ErrState`); attended ↔ no_show may be corrected; a
  no_show slot still blocks its slot capacity; `SyncSessionStart` moves bookings' `starts_at`;
  `Migrate` backfills a NULL `starts_at`.
- [x] **Step 2: Run, verify failures.**
- [x] **Step 3: Implement** as listed in File structure.
- [x] **Step 4: Run `go test ./modules/event/... ./internal/app/...`, lint.**

### Task 2: View presets (Go)

- [x] **Step 1: Failing test** (`presets_test.go`): after `Migrate`, each company of a tenant has
  graph layouts for `event_booking` and `event_session` and the tenant has the `calc_fill_rate`
  graph field; an existing value is left untouched.
- [x] **Step 2–4:** implement `presets.go` (skips when `app_settings`/`company`/`graph_field`
  don't exist yet), run, lint.

### Task 3: ERP views

- [x] **Step 1: Failing test** (`EventViews.test.ts`): status options include attended/no_show;
  `event.checkIn` / `event.noShow` commit the status; buttons visible only on confirmed bookings;
  bookings list shows event and start.
- [x] **Step 2–4:** implement, vitest, tsc.

### Task 4: Docs

- [x] ADR-026 addendum (held seats, check-in), `CLAUDE.md` event entry, i18n catalogs.
