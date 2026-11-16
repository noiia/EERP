# Project App Phone Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every view of the Project app (task lists in List, Kanban, Calendar, Graph, Gantt, WBS, PERT, OBS and Risk modes, plus the project/task/risk forms) usable on a phone (viewport < 600px), using as much of the screen as possible.

**Architecture:** The Project app is descriptors only (`core/modules/project/views/project_views.ts`); every view it shows is drawn by the shared engine in `core-front/packages/core-front/src/views/`. So the work is in the engine renderers, gated on one shared `usePhone()` hook. Desktop layout must stay pixel-identical. Every change is behind `phone === true`, or a `sx` `xs` breakpoint value whose `sm` value is today's.

**Tech Stack:** React 19, Next.js App Router, MUI 7 (`useMediaQuery`, `sx` breakpoints), React Flow (`@xyflow/react`), Vitest + Testing Library + jsdom.

**Spec:** this document (no separate spec). Context to read first: `core-front/CLAUDE.md` (rows *List display modes*, *Banners*, *Top-bar header menus*), `docs/roadmaps/responsive-displays.md`, `docs/adr/ADR-039-diagram-views.md`, `docs/adr/ADR-040-risk-analysis.md`.

## Global Constraints

- **Phone** = viewport width `< layout.phoneMaxWidth` (600px, `tokens.ts`), detected in JS with `useMediaQuery(\`(max-width:${layout.phoneMaxWidth - 0.05}px)\`)` (the same query `AppTopBar.tsx:445` uses). CSS-only changes use `sx` breakpoint objects `{ xs: <phone>, sm: <today's value> }`.
- **Desktop must not change.** Each existing test must still pass unmodified. At ≥ 600px, the DOM must be unchanged apart from added `data-testid`s.
- **Touch:** HTML5 `draggable` drag-and-drop does not fire on touch screens. Every move that today needs a drag (Kanban card, Calendar card) gets a tap alternative on phone. Pointer-event drags (Gantt, React Flow) already work on touch and stay.
- **Touch targets** added by this plan are at least 40×40px on phone.
- New user-facing strings go through `useT()` / `t('…')` and get a `msgid` in `core-front/apps/shell/i18n/shell.pot` with its French translation in `core-front/apps/shell/i18n/fr.po`. The engine's strings live in the shell catalogs.
- New icons: add a named import to `views/icons.ts`, never import `fas`.
- No new dependency.
- Tests: engine `cd core-front/packages/core-front && npx vitest run <file>`; shell `cd core-front/apps/shell && npx vitest run <file>`; typecheck `npx tsc --noEmit -p .` in each package. Coverage floors: 80% (see root CLAUDE.md "Before pushing"). Run `make test` before the final push.
- Commits: `<type>(core-front): <description>`, ending with the attribution line the session's system prompt gives.
- Docs: update `core-front/CLAUDE.md`'s *List display modes* row (and any other row a task changes) in the task that changes the behavior. Add a "Phone mode" section to `docs/roadmaps/responsive-displays.md` in Task 9.
- Use `rg`, never `grep`. Before any codebase search, run `graphify query "<question>"` (see the root CLAUDE.md graphify rule). After code changes, run `graphify update .`.

## Review Focus

1. **Rotating the phone, or resizing a desktop window across 600px, while a view is open** must not lose state. Kanban/Gantt/diagram state and the open mode must be kept (no remount that drops an unsaved diagram note or the Gantt anchor). Pinned in Task 1 (`usePhone` re-renders, not remounts) and in each renderer's "toggles phone without losing X" test.
2. **A task list with 9 modes on a 360px screen.** The mode picker must stay one line and show the current mode (Task 2).
3. **Moving a Kanban card on a touch device** must work without drag, including into a merged many2one column (it goes through `resolveDropTarget`, refusal message included). Pinned in Task 3.
4. **Full-screen diagram + browser Back button / Escape** must leave full screen and must not navigate away with unsaved positions. Pinned in Task 6.
5. **Read-only users on phone** (no `<entity>:<entity>:write`) must not see the new Move/Schedule controls (Tasks 3, 4).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core-front/src/views/use-phone.ts` (new) | `usePhone(): boolean`, the single phone test |
| `packages/core-front/src/test/viewport.ts` (new) | `setViewportWidth(px)` test helper (jsdom `matchMedia` stub honoring `max-width`) |
| `packages/core-front/src/test/setup.ts` | install the default `matchMedia` stub (desktop, 1280px) |
| `apps/shell/app/app/layout.tsx`, `views/tokens.ts`, `apps/shell/src/teams/TeamsWorkspace.tsx` | phone page inset |
| `views/renderers.tsx` | `DisplayModeSwitcher` phone variant |
| `views/kanban-renderer.tsx` | snap columns + "Move to" menu |
| `views/calendar-renderer.tsx` | compact month + day agenda + Unscheduled below |
| `views/gantt-renderer.tsx` | phone range, narrow labels, icon toolbar, bigger handles |
| `views/diagram/diagram-canvas.tsx` | full-screen toggle, phone toolbar |
| `views/risk/risk-renderer.tsx`, `risk-matrix.tsx`, `risk-register.tsx` | phone tabs/actions, compact matrix, register as cards |

---

### Task 1: `usePhone` hook, viewport test helper, phone page inset

**Files:**
- Create: `core-front/packages/core-front/src/views/use-phone.ts`, `core-front/packages/core-front/src/views/use-phone.test.tsx`, `core-front/packages/core-front/src/test/viewport.ts`
- Modify: `core-front/packages/core-front/src/test/setup.ts`, `core-front/packages/core-front/src/views/index.ts` (export `usePhone`), `core-front/packages/core-front/src/views/tokens.ts` (`layout`), `core-front/apps/shell/app/app/layout.tsx:186-190`, `core-front/apps/shell/src/teams/TeamsWorkspace.tsx:150-154`

**Interfaces:**
- Produces: `usePhone(): boolean` (exported from both barrels' views index); `setViewportWidth(width: number): void` in `src/test/viewport.ts` (sets `window.innerWidth`, makes `window.matchMedia(q)` evaluate `(max-width:Npx)` / `(min-width:Npx)` against it, dispatches `resize` and fires the registered `change` listeners); `layout.pageInsetPhone = '8px'`.

- [ ] **Step 1: Write the failing tests** in `use-phone.test.tsx`:
  - `it('is false at 1280px and true at 390px')`: `setViewportWidth(1280)` → `renderHook(usePhone).result.current === false`; `setViewportWidth(390)` → `true`.
  - `it('updates without remounting when the viewport crosses 600px')`: render a component that keeps a `useRef` counter of mounts, displays `usePhone()`, and asserts the text flips from `desktop` to `phone` after `act(() => setViewportWidth(390))` while the mount counter stays 1.
- [ ] **Step 2: Run** `npx vitest run src/views/use-phone.test.tsx`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** `usePhone` wraps MUI `useMediaQuery` with the Global Constraints query, `{ noSsr: false }` (server renders desktop, like `AppTopBar`). In `setup.ts`, install the stub at 1280px before each file so engine tests that never call `setViewportWidth` behave as desktop. Reset to 1280 in `afterEach`.
- [ ] **Step 4: Phone page inset.** Add `pageInsetPhone: '8px'` to `layout`. In the ERP layout, use `px: { xs: layout.pageInsetPhone, sm: layout.pageInsetX }` and `py: { xs: layout.pageInsetPhone, sm: layout.pageInsetY }`. In `TeamsWorkspace` the negative full-bleed margins mirror the inset: `mx: { xs: \`calc(-1 * ${layout.pageInsetPhone})\`, sm: \`calc(-1 * ${layout.pageInsetX})\` }`, same for `my`. Add a `tokens.test.ts` assertion that `pageInsetPhone` is `'8px'`.
- [ ] **Step 5: Run** the engine and shell suites touched (`use-phone`, `tokens`, `TeamsWorkspace` tests) plus both `tsc`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(core-front): usePhone hook and phone page inset`.

### Task 2: Display mode picker on phone

**Files:**
- Modify: `core-front/packages/core-front/src/views/renderers.tsx:900-955` (`MODE_LABELS`, `DisplayModeSwitcher`)
- Test: `core-front/packages/core-front/src/views/renderers.test.tsx` (new `describe('DisplayModeSwitcher on phone')`)

**Interfaces:**
- Consumes: `usePhone()`, `setViewportWidth()` (Task 1).

- [ ] **Step 1: Write the failing tests:**
  - `it('shows one "View: <mode>" button instead of the toggle group on phone')`: at 390px, render a tree view with kanban+calendar+gantt available. Expect `queryByRole('group', { name: 'Display mode' })` to be null and `getByRole('button', { name: 'Display mode: List' })` to exist.
  - `it('switches mode from the menu')`: click that button, click `menuitem` `Gantt`, and expect the Gantt renderer (`getByTestId('gantt-track')`) to show.
  - `it('keeps the toggle group at desktop width')`: at 1280px, the `group` named `Display mode` exists (existing behavior).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** On phone, `DisplayModeSwitcher` renders a full-width outlined `Button` labeled `t(MODE_LABELS[mode])` with a trailing `chevron-down` icon (`aria-label` = `` `${t('Display mode')}: ${t(MODE_LABELS[mode])}` ``) opening a MUI `Menu` of the same `candidates` (the current one `selected`). The `onChange` path is unchanged.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core-front): display mode menu on phone`.

### Task 3: Kanban on phone, one column per screen and "Move to"

**Files:**
- Modify: `core-front/packages/core-front/src/views/kanban-renderer.tsx` (`dropCard` at :297, column `sx` at :410, card at :469)
- Test: `core-front/packages/core-front/src/views/kanban-renderer.test.tsx`

**Interfaces:**
- Produces: `dropCard(column: KanbanColumn | null, id: string)` (the drag path passes `draggingId`). Same refusal/`resolveDropTarget` behavior.

- [ ] **Step 1: Write the failing tests** (at 390px unless stated):
  - `it('sizes unfolded columns to 85% of the board and snaps them')`: the column `group` has computed `flex-basis` `85%` and the board has `scroll-snap-type: x mandatory`.
  - `it('moves a card with the "Move to" menu')`: click `getByRole('button', { name: 'Move <card label>' })` → `menuitem` `Done` → `actions.update` called with `{ stage_id: <done id> }` (same payload as a drop).
  - `it('refuses a move to a merged column without a match, like a drop')`: board unscoped with merged columns; picking a column the card's scope lacks shows the existing message `No column named {name} exists for this card.`.
  - `it('hides "Move to" without write permission')`: no `<entity>:<entity>:write` → no `Move …` button.
  - `it('keeps 240px columns and no Move button on desktop')`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Change `dropCard` to take the id explicitly. On phone, unfolded columns get `flex: '0 0 85%'`, `scrollSnapAlign: 'start'`, and the board container gets `scrollSnapType: 'x mandatory'`. Each card gets a 40px `IconButton` (`arrows-up-down-left-right` icon, `aria-label` `` `${t('Move')} ${label}` ``, `stopPropagation` so the card doesn't open) opening a `Menu` of every other column (folded included), each item calling `dropCard(column, record.id)`. Column header drag-reorder stays desktop-only (HTML5 DnD).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core-front): kanban phone layout and move menu`.

### Task 4: Calendar on phone, compact month and day agenda

**Files:**
- Modify: `core-front/packages/core-front/src/views/calendar-renderer.tsx` (layout at :300-380)
- Test: `core-front/packages/core-front/src/views/calendar-renderer.test.tsx`

- [ ] **Step 1: Write the failing tests** (390px):
  - `it('shows a count badge per day instead of cards')`: a day with 3 records shows text `3` in `getByRole('button', { name: /^<day> — 3/ })` and no card labels inside the grid.
  - `it('lists the tapped day's records below the grid')`: tap the day and expect a `list` named `<localized date>` with the 3 record labels. Tapping a label opens the form (same `openForm` as a card click).
  - `it('stacks Unscheduled below the agenda, full width')`: the `group` `Unscheduled` follows the agenda in DOM order and has no 220px width.
  - `it('schedules an unscheduled record on the selected day')`: with write permission, select a day, then the unscheduled card's `Schedule on <date>` button calls `actions.update` with `{ deadline: '<iso>' }`. It is hidden without write permission or with no day selected.
  - `it('keeps the desktop month grid')` at 1280px.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** On phone, render day cells as square buttons (`aspectRatio: '1'`, number + count badge), keep `selectedDay` state (default today when in the shown month), render the agenda `List` below, then the Unscheduled panel (`width: '100%'`, `Stack direction="column"`). `Schedule on` calls the existing `moveField(record.id, iso)`. Quick create on an empty day stays as is.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core-front): calendar phone agenda`.

### Task 5: Gantt on phone

**Files:**
- Modify: `core-front/packages/core-front/src/views/gantt-renderer.tsx` (`viewRange` :103, `shiftAnchor` :115, `scrollAnchor` :131, toolbar :651-685, grid template :689, `handleSx` :571, Unscheduled :859)
- Test: `core-front/packages/core-front/src/views/gantt-renderer.test.tsx`

**Interfaces:**
- Produces: `viewRange(zoom: Zoom, anchor: Date, phone = false)` and `shiftAnchor(zoom, anchor, dir, phone = false)`. Phone spans: day = 7 days, week = 6 weeks, month = 3 months; the shift steps by the same span. `scrollAnchor` is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `it('shows 7 day columns in Day zoom on phone')`, `it('shows 6 week columns in Week zoom on phone')`, `it('shows 3 months in Month zoom on phone')`: count `columnLabel` captions in `gantt-track`.
  - `it('loads only the phone range')`: the `listPage` call carries `lt[date_start]` = range start + 7 days in Day zoom.
  - `it('Next moves by the phone span')`: Day zoom, click `Next period` → first header label is +7 days.
  - `it('uses icon buttons and puts the range on its own line on phone')`: `Previous period`/`Next period` are `IconButton`s; the range `subtitle2` sits on its own full-width line.
  - `it('narrows the name column to 88px and clamps names to two lines')`: grid `grid-template-columns` starts with `88px`.
  - `it('gives bar edge handles a 16px touch area on phone')`.
  - `it('stacks Unscheduled below the timeline on phone')`.
  - `it('keeps the desktop range when the viewport crosses back')`: switch 390 → 1280px, Day zoom shows 14 columns, and the zoom/anchor state is kept.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Thread `phone` from `usePhone()` into `viewRange`/`shiftAnchor` (the load effect already depends on `range`). The name column on phone is `88px` with `WebkitLineClamp: 2` caption text. `handleSx.width` is `{ xs: 16, sm: 8 }`. The Unscheduled `Stack` gets `direction={{ xs: 'column', sm: 'row' }}` and the panel gets `width: { xs: '100%', sm: 220 }`. Bars keep `touchAction: 'none'` (a vertical page scroll must start outside a bar; note it in the CLAUDE.md row).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core-front): gantt phone range and layout`.

### Task 6: Diagrams (WBS, PERT, OBS): full screen and phone toolbar

**Files:**
- Modify: `core-front/packages/core-front/src/views/diagram/diagram-canvas.tsx` (toolbar :690-702, canvas box :704-712)
- Test: `core-front/packages/core-front/src/views/diagram/diagram-canvas.test.tsx`

**Interfaces:**
- Produces: internal `fullscreen` state. No prop changes, so `PertRenderer`/`WbsRenderer`/`ObsRenderer` get it for free.

- [ ] **Step 1: Write the failing tests:**
  - `it('enters and leaves full screen')` (any width): click `Full screen` → the canvas wrapper has `position: fixed` and `inset: 0`, and the button reads `Exit full screen`. `Escape` (not typing in a field) exits.
  - `it('exits full screen on browser Back without leaving the page')`: entering pushes a history entry (`history.pushState`). A `popstate` exits full screen and the route doesn't change.
  - `it('fits the view after toggling full screen')`: `fitView` called once after each toggle.
  - `it('starts full screen-capable canvas at the remaining viewport height on phone')`: at 390px the wrapper height is `calc(100dvh - 160px)` (top bar + mode picker + toolbar).
  - `it('shows Fit, Undo, Redo, Full screen and a More menu on phone')`: Re-arrange, Export PNG, Export PDF, Add note, help and legend move into `getByRole('button', { name: 'More' })`'s menu. Desktop toolbar is unchanged.
  - `it('keeps notes and positions when toggling full screen')`: add a note, toggle twice, the note is still there (no remount).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The full screen toggle is CSS only on the same element (`position: fixed, inset: 0, zIndex: theme.zIndex.drawer + 2, bgcolor: background.default, height: 100dvh`), never a portal or remount. Use the `expand`/`compress` icons. Keep the toolbar inside the fixed box. Escape and `popstate` exit, and the toggle pushes one history entry when entering (and goes `history.back()` when exiting by button). On phone, the toolbar is one non-wrapping row as listed.
- [ ] **Step 4: Run** the tests, plus `pert-renderer`, `wbs-renderer` and `obs-renderer` tests unchanged. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core-front): diagram full screen and phone toolbar`.

### Task 7: Risk mode on phone

**Files:**
- Modify: `core-front/packages/core-front/src/views/risk/risk-renderer.tsx:108-135`, `risk/risk-matrix.tsx:21`, `risk/risk-register.tsx`
- Test: `core-front/packages/core-front/src/views/risk/risk-renderer.test.tsx`

- [ ] **Step 1: Write the failing tests** (390px):
  - `it('puts full-width tabs on their own row and actions below')`: `Tabs` has `variant="fullWidth"` (each tab ~⅓ width) and `New risk` is in a following row.
  - `it('fits the matrix in the screen')`: matrix `grid-template-columns` uses `minmax(0, 1fr)` and chips show the risk's short label (first 12 characters + `…`), with the full name as `aria-label`.
  - `it('shows the register as cards')`: no `table`. One `listitem` per risk with name, criticity chip and category, and tapping it opens the risk form.
  - `it('keeps the desktop table and 120px matrix columns')` at 1280px.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** as tested. Matrix and Ishikawa heights become `{ xs: 'calc(100dvh - 220px)', sm: '70vh' }`. The `Current / After remediation` toggle becomes `Now / After` on phone (new msgids).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core-front): risk views on phone`.

### Task 8: List and Graph spot fixes (verify first)

**Files:** modify only what the check finds, in `views/renderers.tsx` (list) and `views/search-bar.tsx`.

- [ ] **Step 1:** Run the app (`run` skill, or `make run`), seed the light demo data, and open `/app/project/tasks?filter[project_id]=<large project>` at 390×844 (Chrome device mode or Playwright `viewport`). Screenshot List, Graph and the search bar with the filter dropdown open, and the task form (status bar, notebook tabs, chatter, mind-map on the project form).
- [ ] **Step 2:** For each defect seen (horizontal page scroll, controls cut off, targets < 40px), write a failing test in the matching renderer test file at 390px that names the defect, fix it behind `usePhone()` or an `xs` value, and get it to pass. **Expected minimum:** the List grid keeps horizontal scroll inside the grid only (`overflowX` on the grid wrapper), and the search bar's filter `Menu` is full width (`slotProps.paper.sx.width: { xs: 'calc(100vw - 16px)' }`).
- [ ] **Step 3: Commit** `fix(core-front): project list and search bar on phone`.

### Task 9: End-to-end phone check, docs, push gate

- [ ] **Step 1:** At 390×844 and 360×740, walk every Project route (`/project`, `/project/:id`, `/project/tasks` in each of the 9 modes, `/project/my-tasks`, milestones, timesheets, risks, colors), portrait and landscape. Check there's no horizontal page scroll (`document.documentElement.scrollWidth <= innerWidth`) and that every action is reachable. Save the screenshots to the scratchpad and list any defect as a new Task 8-style fix.
- [ ] **Step 2:** Docs. Add a "Phone mode" section to `docs/roadmaps/responsive-displays.md` (the `usePhone` contract, the per-mode behavior table, the touch rule "no HTML5-drag-only action on phone"). Update `core-front/CLAUDE.md`: the *List display modes* row (Kanban Move menu, Calendar agenda, Gantt phone spans, diagram full screen, Risk cards) and the `layout.pageInsetPhone` mention.
- [ ] **Step 3:** `graphify update .`, then `make test`. Expected: all green, coverage at or above the floors.
- [ ] **Step 4: Commit** `docs(core-front): project phone mode`.

---

## Appendix: ideas for new Project diagrams and views

These are not part of this plan. Each is a candidate for its own spec. **Data** says whether today's tables suffice.

| Idea | What it shows | Data |
|---|---|---|
| **Workload / resource histogram** | Planned hours per assignee per week (task `planned_hours` spread over `date_start`→`deadline`), red above capacity. A heatmap of people × weeks. | Exists. Capacity per user (hours/week) would be a new setting. |
| **Critical path on Gantt** | Highlights the zero-slack chain and shows each bar's slack. `pert.ts` / `risk_calc.go` already compute the critical path. | Exists |
| **Milestone roadmap** | Milestones on a timeline (`deadline`, `reached_at`), late ones flagged, progress = `task_done_count / task_count`. | Exists |
| **Timesheet week grid** | Tasks × 7 days entry grid with row/column totals. Faster than one form per entry, and phone-friendly as "log hours today". | Exists (`project_timesheet`) |
| **My day (phone home)** | My tasks overdue / today / this week, one-tap "log 1h" and "done". The natural phone entry point. | Exists |
| **Eisenhower matrix** | Priority (stars) × urgency (deadline distance) in four quadrants. | Exists |
| **Swimlane Kanban** | The Kanban split into rows by assignee (or color group). | Exists (needs junction-aware grouping) |
| **Portfolio dashboard** | A bubble chart per project: x = % done, y = schedule slip (latest deadline vs `date_end`), size = spent hours, color = top risk criticity. | Exists |
| **Hours-based earned value (EVM)** | PV / EV / AC curves and SPI / CPI over time, from `planned_hours`, completion and timesheets. | Mostly. Needs a task `closed_at` for EV over time. |
| **Burndown / burnup** | Remaining vs completed hours or tasks per day, for a project or milestone. | Needs `closed_at` on `project_task` (trigger-set when `closed` flips). |
| **Cumulative flow diagram** | Task count per stage over time; shows bottlenecks. | Needs a stage-history table (task, stage, entered_at), trigger-maintained. |
| **Baseline vs actual Gantt** | A ghost bar of the saved plan under each actual bar. | Needs a `project_baseline` snapshot table. |
| **RACI matrix** | Tasks × members with R/A/C/I cells. | Needs a role column on `project_task_user` (or a new junction). |
| **Dependency matrix (DSM)** | A task × task grid of `project_task_dependency`. Spots cycles and clusters on large projects where PERT gets busy. | Exists |
| **Risk trend** | Criticity / residual criticity over time and the risk count per band. | Needs a risk history table. |

Suggested order (most value, least new data): Critical path on Gantt → My day → Timesheet week grid → Workload histogram → Milestone roadmap → `closed_at` + Burndown.
