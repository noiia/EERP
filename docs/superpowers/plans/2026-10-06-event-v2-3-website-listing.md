# Event v2 · SP3 — Website listing — Implementation Plan

**Spec:** [Event v2 overview § SP3](../specs/2026-10-06-event-v2-overview.md#sp3-website-listing)

**Goal:** visitors browse upcoming events on the site and land on one generic event page that
books whichever event the URL names.

**Global constraints:** the listing respects the `event` table's published scope (ADR-024):
404 when unpublished, only published columns, forced filter enforced. Block types stay one closed
set in Go and TS.

## File structure

- `core/modules/event/models.go` — `Event.Picture` flag (pictures widget anchor)
- `core/modules/event/handler.go` — `PublicUpcoming(resolve)`; wired in `internal/app/app.go`
  under the public group as `GET /api/v1/public/events/upcoming`
- `core/modules/website/validate.go` — `event_list` block type; `TestBlockTypes_MatchFrontend`
- `core-front/apps/shell/src/website/blocks/EventListBlock.tsx` + `EventList.tsx` — the block
- `core-front/apps/shell/src/website/blocks/BlockView.tsx` — booking blocks fall back to the URL id
- editor: `BlockPalette.tsx`, `BlockSettings.tsx`, `layout-ops.ts` defaults, `editor-actions.ts`
  preview of URL-driven booking blocks
- `core/modules/event/views/EventViews.ts` — picture in the event form header

### Task 1: Public upcoming route (Go)

- [x] Failing app test `TestPublicUpcomingEvents` (listed/unlisted events, unpublished column
  hidden, limit 400, unpublished table 404); implement; vet.

### Task 2: Block type

- [x] Failing sync test; add `event_list` to Go `BlockTypes` and TS `BLOCK_TYPES`.

### Task 3: Site block + URL-driven booking

- [x] Failing `event-list.test.tsx` (cards with link/picture/seats/Full/Book a slot, list
  display, 404 → nothing, URL fallback, wrong kind → nothing); implement; tsc, eslint.

### Task 4: Editor + ERP form + i18n + docs

- [x] Palette label, default size, settings form (display, limit, event page), "the event in the
  URL" option, preview fallback, event form picture, shell/event catalogs, CLAUDE docs.
