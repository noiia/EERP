# Project WBS and PERT Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WBS and PERT display modes to the Project task lists: live, editable, draggable diagrams with per-user layouts, a critical path and PNG/PDF export.

**Architecture:** Two generic view modes in the `@eerp/core-front` engine, configured per descriptor the way Gantt is (`wbsParentField`, `wbsGroupField`, `pertDependencies`), rendered with `@xyflow/react` over a shared `DiagramCanvas`. The math (PERT passes, WBS tree, auto-layouts, collision) is pure and unit-tested. Edits go through the existing `EntityActions` / `RelationOps`. Per-user layouts live in a new Go table `user_view_layout` behind `GET|PUT /api/v1/me/view_layout/:entity/:mode`, reached through two new optional `RelationOps` methods.

**Tech Stack:** Go (echo v5, core/orm), Next.js + React + MUI, `@xyflow/react` 12.12.1, `html-to-image`, `jspdf`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-project-wbs-pert-design.md`

## Global Constraints

- Duration: `planned_hours > 0` → `planned_hours / 8` days. Otherwise `(deadline - date_start)` in calendar days when both are set and > 0. Otherwise 1 day, flagged `noEstimate`.
- Time zero = the earliest `date_start` among the shown tasks, else today (local midnight). No weekends or holidays.
- Critical = slack < 1e-6.
- Load cap: 2000 tasks (page size 200, page until a short page, one probe row past the cap, like `gantt-renderer.tsx`'s `loadRange`). Above the cap → a "narrow the filter" notice and no diagram.
- Inline-editable fields: `name`, `stage_id`, `date_start`, `deadline`, `planned_hours`. A double-click opens the form.
- Layout limits (server): `mode` ∈ {`wbs`,`pert`}; `entity` matches `^[a-z0-9_]{1,64}$`; ≤ 2000 position ids, ids ≤ 300 chars, finite coordinates within ±10⁶; ≤ 2000 folded ids. Over a limit → 400.
- Empty layout reads `{"positions": {}, "folded": []}`.
- Layout save is debounced 500 ms after the last drag or fold change.
- Never `Hub.Broadcast` / no shared state: layouts are the caller's own row only.
- Every UI string is a msgid added to `core-front/apps/shell/i18n/fr.po` (engine strings) or `core/modules/project/i18n/{project.pot,fr.po}` (project strings).
- `make test` green with coverage floors intact (Go 85 %, engine/shell 80 %). Never lower a threshold.
- Toolchain: `export PATH=$PATH:/usr/local/go/bin`; DB tests need `CONFIG=/home/noia/development/EERP/eerp-config.json` and `-timeout`; pnpm is `npx -y pnpm@12.18.0` from `core-front/`; rebuild the engine (`npx -y pnpm@12.18.0 build` in `packages/core-front`) before shell tests; add deps by editing `package.json` then `pnpm install`, never `pnpm add`; never run Prettier on `core/modules/*/views`.
- Commits: `git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com commit …`, format `<type>(scope): <description>`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A dependency whose other end is filtered out:** no arrow, no effect on the critical path, and an "n hidden links" note → `pert.test.ts` `ignores links to tasks outside the set` (Task 3).
2. **A deadline before or equal to the start date, or only one of the two dates set:** treated as no estimate (1 day, flagged), never a negative or zero duration → `pert.test.ts` `inverted or partial dates are no estimate` (Task 3).
3. **A re-parent onto the task's own descendant, or onto itself:** refused in the client with no PUT sent (the backend would 422 anyway) → `wbs.test.ts` `canReparent refuses self and descendants` (Task 4), used by Task 9.
4. **A rejected edit (422 cross-project parent, 403 not manager, 409 dependency duplicate):** the error alert shows, and the box and its value snap back to the server state → `wbs-renderer.test.tsx` `reverts on a rejected reparent` (Task 9), `pert-renderer.test.tsx` `reverts on a rejected link` (Task 10).
5. **A stale saved layout (positions for deleted tasks, a new task with none, overlapping saved boxes after a resize):** saved boxes are kept, new ones placed clear of them, stale ids dropped on the next save → `diagram-canvas.test.tsx` `merges saved positions with auto layout` (Task 8).

---

## File Structure

| File | Responsibility |
|---|---|
| `core/internal/settings/viewlayout.go` (+ `_test.go`) | `UserViewLayout` model, validation, GET/PUT handlers |
| `core/modules/settings/module.go` | register the table, add its unique index in `Migrate` |
| `core/internal/app/app.go` | mount the two routes on `meGroup` |
| `core-front/packages/core-front/src/views/diagram/collide.ts` (+ test) | collision helpers, moved from the shell |
| `core-front/packages/core-front/src/views/diagram/pert.ts` (+ test) | durations, forward/backward passes, slack, critical set, cycles |
| `core-front/packages/core-front/src/views/diagram/wbs.ts` (+ test) | tree build, fold, rollups, re-parent guard |
| `core-front/packages/core-front/src/views/diagram/auto-layout.ts` (+ test) | WBS tidy tree, PERT rank layout |
| `core-front/packages/core-front/src/views/diagram/export.ts` (+ test) | PNG/PDF export |
| `core-front/packages/core-front/src/views/diagram/diagram-canvas.tsx` (+ test) | shared React Flow canvas: loading, layout merge, drag + collision, save, toolbar, legend |
| `core-front/packages/core-front/src/views/diagram/task-box.tsx` | box with inline-edit fields (shared by both modes) |
| `core-front/packages/core-front/src/views/diagram/wbs-renderer.tsx` (+ test) | WBS mode |
| `core-front/packages/core-front/src/views/diagram/pert-renderer.tsx` (+ test) | PERT mode |
| `core-front/packages/core-front/src/api/view-fields.ts` (+ test) | new config keys and display modes |
| `core-front/packages/core-front/src/views/relation-ops.tsx` | optional `getViewLayout` / `saveViewLayout` |
| `core-front/packages/core-front/src/views/renderers.tsx` | dispatch `wbs` / `pert` modes |
| `core-front/apps/shell/src/lib/relation-actions.ts` + `app/app/layout.tsx` | bind the layout ops |
| `core-front/apps/shell/src/website/workflow-collide.ts` | becomes a re-export of the engine helpers |
| `core/modules/project/views/project_views.ts` (+ test) | enable the modes on task lists |
| docs: `CLAUDE.md`, `core-front/CLAUDE.md`, `docs/adr/ADR-039-diagram-views.md` | |

---

### Task 1: Per-user view layout API (Go)

**Files:**
- Create: `core/internal/settings/viewlayout.go`, `core/internal/settings/viewlayout_test.go`
- Modify: `core/modules/settings/module.go` (Register + Migrate), `core/internal/app/app.go:335` (next to `/preferences`), `CLAUDE.md` (the `internal/settings/` bullet)

**Interfaces:**
- Produces: `GET /api/v1/me/view_layout/:entity/:mode` → `200 {"positions": {"<id>": {"x": n, "y": n}}, "folded": ["<id>"]}`; `PUT` same body → `204`. 400 `VALIDATION_ERROR` on any limit.
- Go: `type UserViewLayout struct { model.BaseModel; UserID uuid.UUID `db:"user_id,index"`; Entity string `db:"entity"`; Mode string `db:"mode"`; Layout string `db:"layout"` }` (table `user_view_layout`, `tenant_id` as other settings tables carry it). Mirror `internal/presence`'s `UserPresence` shape: a hand-written unique index `(tenant_id, user_id, entity, mode)` in the settings module's `Migrate`, writes via `Repository.Upsert(ctx, row, []string{"tenant_id","user_id","entity","mode"}, "layout = EXCLUDED.layout, updated_at = now()")`. Registered `orm.WithExcluded()`.
- `func NewViewLayoutHandler(db *orm.DB) *ViewLayoutHandler`, methods `Get(c *echo.Context) error`, `Put(c *echo.Context) error`. Tenant and user come from the JWT context, like `GetMyPreferences`.

- [ ] **Step 1: Write the failing tests** (table-driven, `t.Run`, `testdb.Open(t)` + `testdb.MigrateModules(t, app, "auth", "settings")`, fresh `uuid.New()` tenant):
  - `TestViewLayout_EmptyDefault`: GET with nothing saved → 200, body `{"positions":{},"folded":[]}`.
  - `TestViewLayout_RoundTripAndReplace`: PUT A, GET = A; PUT B, GET = B (whole replace, one row in DB).
  - `TestViewLayout_OwnRowOnly`: user 1 PUT, user 2 GET same entity/mode → empty default; other tenant → empty.
  - `TestViewLayout_Limits`: subtests → 400 for mode `gantt`, entity `Bad-Name`, 2001 ids, 301-char id, `x = 1e7`, NaN-like (JSON can't carry NaN, so test `1e309` → decode error → 400), 2001 folded ids.
  - `TestViewLayout_DBError`: `testdb.Closed(t)` → 500 on GET and PUT.
- [ ] **Step 2: Run** `cd core && CONFIG=… go test -timeout 120s ./internal/settings/ -run TestViewLayout` → FAIL (undefined).
- [ ] **Step 3: Implement** the model, `validate()` (reuse `internal/website/workflowlayout.go`'s `validate` rules for coordinates), the handlers, registration, the index and the routes (`meGroup.GET("/view_layout/:entity/:mode", …)`, `meGroup.PUT(…)`).
- [ ] **Step 4: Run** the tests → PASS. Run `go test -timeout 300s ./internal/app/ -run TestRoutes` → PASS (the route table test must list the new routes if it enumerates them).
- [ ] **Step 5: Update** the `internal/settings/` bullet in `CLAUDE.md` with one sentence on `user_view_layout` and its routes.
- [ ] **Step 6: Commit** `feat(settings): per-user view layout API for diagram modes`.

### Task 2: Move collision helpers into the engine and add the diagram deps

**Files:**
- Create: `core-front/packages/core-front/src/views/diagram/collide.ts` (content moved from `apps/shell/src/website/workflow-collide.ts`), `…/diagram/collide.test.ts` (moved from `workflow-collide.test.ts`)
- Modify: `apps/shell/src/website/workflow-collide.ts` → `export * from '@eerp/core-front/…'` (use the engine's public export path; add the export to the engine's index), delete the shell's test file; `packages/core-front/package.json` dependencies += `"@xyflow/react": "12.12.1"`, `"html-to-image": "<latest 1.x at least two weeks old>"`, `"jspdf": "<latest 3.x at least two weeks old>"`; then `npx -y pnpm@12.18.0 install`.

**Interfaces:**
- Produces: `overlaps`, `freeSpot`, `separateBoxes`, `DEFAULT_NODE_SIZE`, `NODE_GAP`, `Point`, `Rect` exported from the engine (`bezierPoint`, `placeLabels`, `labelSize` move too, so the shell file stays a pure re-export).

- [ ] **Step 1:** Move the files; run `npx -y pnpm@12.18.0 --filter @eerp/core-front exec vitest run src/views/diagram/collide.test.ts` → PASS.
- [ ] **Step 2:** Rebuild the engine; run the shell workflow tests `npx -y pnpm@12.18.0 --filter @eerp/shell exec vitest run workflow` → PASS (unchanged behavior).
- [ ] **Step 3: Commit** `refactor(core-front): move diagram collision helpers into the engine`.

### Task 3: PERT math

**Files:** Create `…/views/diagram/pert.ts`, `…/views/diagram/pert.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PertTaskInput { id: string; plannedHours?: number | null; dateStart?: string | null; deadline?: string | null }
  export interface PertLink { from: string; to: string }   // from = blocker (depends_on_id), to = dependent (task_id)
  export interface PertNode { id: string; duration: number; noEstimate: boolean; es: number; ef: number; ls: number; lf: number; slack: number; critical: boolean }
  export interface PertResult { nodes: Record<string, PertNode>; criticalLinks: Set<string>; hiddenLinks: number; cycle: string[] | null; origin: Date; finish: number }
  export const HOURS_PER_DAY = 8
  export function taskDuration(t: PertTaskInput): { days: number; noEstimate: boolean }
  export function computePert(tasks: PertTaskInput[], links: PertLink[], today?: Date): PertResult
  export function offsetToDate(origin: Date, days: number): Date
  ```
  `criticalLinks` keys are `` `${from}->${to}` ``. On a cycle, `cycle` lists its ids, and every node has `critical: false` and the es/ef etc. of a topological attempt left at 0.

- [ ] **Step 1: Write failing tests:**
  - `taskDuration`: `{plannedHours: 16}` → `{days: 2, noEstimate: false}`; hours win over dates; `dateStart 2026-01-01, deadline 2026-01-04` → 3; `inverted or partial dates are no estimate` (deadline before start, equal, only one set, `plannedHours: 0`) → `{days: 1, noEstimate: true}`.
  - `chain`: A(2)→B(3)→C(1) → finish 6, all critical, slack 0, `criticalLinks` has `A->B`, `B->C`.
  - `diamond`: A(1)→B(5)→D(1), A→C(2)→D → C slack 3, B critical, C not; `A->C` not critical.
  - `parallel critical chains`: two independent chains of equal length 4 → both all critical.
  - `ignores links to tasks outside the set`: link `A->Z` with Z absent → `hiddenLinks: 1`, A unaffected.
  - `cycle`: A→B→A → `cycle` contains A and B, no node critical, no throw.
  - `origin`: earliest `dateStart` among tasks; with none, `today` at local midnight.
- [ ] **Step 2: Run** `…vitest run src/views/diagram/pert.test.ts` → FAIL.
- [ ] **Step 3: Implement** with Kahn's topological sort (detects the cycle), a forward pass (`es = max(ef of blockers)`, 0 for sources), a backward pass from `finish = max(ef)`, `slack = ls - es`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core-front): PERT critical path computation`.

### Task 4: WBS tree

**Files:** Create `…/views/diagram/wbs.ts`, `…/views/diagram/wbs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WbsInput { id: string; parentId: string | null; groupId?: string | null; groupLabel?: string; plannedHours?: number | null; closed?: boolean }
  export interface WbsNode { id: string; kind: 'group' | 'task'; parentId: string | null; children: string[]; depth: number; hiddenCount: number; hiddenHours: number }
  export function buildWbs(rows: WbsInput[], folded: ReadonlySet<string>): { nodes: Record<string, WbsNode>; roots: string[]; visible: string[] }
  export function canReparent(nodes: Record<string, WbsNode>, taskId: string, newParentId: string | null): boolean
  ```
  Group roots get id `` `group:${groupId}` ``. A task whose `parentId` isn't among the rows hangs under its group root (or is a root itself without groups). `visible` excludes every descendant of a folded node; a folded node's `hiddenCount`/`hiddenHours` sum its whole subtree.

- [ ] **Step 1: Write failing tests:** `groups by project` (two projects → two `group:` roots); `orphan parent filtered out → child under its group`; `fold hides the whole subtree and rolls up count and hours` (3 levels, fold the middle node → `hiddenCount 1`, deeper node absent from `visible`); `canReparent refuses self and descendants` (self → false, grandchild → false, sibling → true, group root id → true meaning "clear parent").
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core-front): WBS tree build and fold`.

### Task 5: Auto-layouts

**Files:** Create `…/views/diagram/auto-layout.ts`, `…/views/diagram/auto-layout.test.ts`

**Interfaces:**
- Consumes: `WbsNode` (Task 4), `PertLink` (Task 3), `separateBoxes`, `overlaps` (Task 2).
- Produces:
  ```ts
  export interface BoxSize { w: number; h: number }
  export function layoutWbs(nodes: Record<string, WbsNode>, roots: string[], visible: string[], size: BoxSize): Record<string, Point>
  export function layoutPert(ids: string[], links: PertLink[], size: BoxSize): Record<string, Point>
  ```
  WBS: top-down tidy tree (leaves get consecutive x slots, a parent centers over its children, y = depth × (h + 60)). PERT: column = longest-path rank from sources (x = rank × (w + 80)), rows ordered by the mean row of their blockers (one barycenter sweep), y = row × (h + 40). A cycle falls back to rank 0 for the remaining nodes. Both finish with `separateBoxes`.

- [ ] **Step 1: Write failing tests:** for both layouts, on a 50-node random fixture (seeded), `no two boxes overlap` (pairwise `overlaps(a, b, 0)` false); WBS `parent centered over children`, `children below parent`; PERT `a dependent is right of its blocker`; PERT on a cycle `returns a position for every id`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core-front): WBS and PERT auto-layouts`.

### Task 6: View config keys, display modes and layout ops

**Files:**
- Modify: `…/src/api/view-fields.ts` (+ `view-fields.test.ts`), `…/src/views/relation-ops.tsx`, `apps/shell/src/lib/relation-actions.ts`, `apps/shell/app/app/layout.tsx` (pass the two ops to `RelationOpsProvider`), `core-front/CLAUDE.md` (descriptor keys section, next to `ganttDependencies`)

**Interfaces:**
- Produces in `view-fields.ts`: `DisplayMode` += `'wbs' | 'pert'` (and `DISPLAY_MODES` in that order after `'gantt'`); `viewModeDefaults` keys `wbsParentField?: string`, `wbsGroupField?: string`, `pertDependencies?: GanttDependenciesConfig` (module-declared only, carried into `EffectiveViewFields` as `… | null`); `availableDisplayModes` → `wbs: effective.wbsParentField != null`, `pert: effective.pertDependencies != null`.
- Produces in `RelationOps`:
  ```ts
  getViewLayout?: (entity: string, mode: 'wbs' | 'pert') => Promise<ViewLayout>
  saveViewLayout?: (entity: string, mode: 'wbs' | 'pert', layout: ViewLayout) => Promise<void>
  export interface ViewLayout { positions: Record<string, Point>; folded: string[] }
  ```
  Optional, fail-open: without them positions just aren't saved. The shell binds them to Task 1's routes through `apiRequest`, returning the empty layout on a GET error.

- [ ] **Step 1: Write failing tests:** `view-fields.test.ts` → `wbs available only with wbsParentField`, `pert available only with pertDependencies`, defaults carried into the effective config; a shell test for `getViewLayout` returning the empty layout when the request throws.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (engine, then rebuild, then shell).
- [ ] **Step 5: Commit** `feat(core-front): WBS/PERT view config keys and per-user layout ops`.

### Task 7: Export

**Files:** Create `…/views/diagram/export.ts`, `…/views/diagram/export.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function diagramToPng(viewport: HTMLElement, bounds: { x: number; y: number; width: number; height: number }): Promise<string>  // data URL, pixelRatio 2
  export async function exportPng(viewport: HTMLElement, bounds: …, filename: string): Promise<void>
  export async function exportPdf(viewport: HTMLElement, bounds: …, meta: { title: string; date: Date; legend: { color: string; label: string }[] }, filename: string): Promise<void>
  export function pdfFormat(width: number, height: number): 'a4' | 'a3'   // a3 when width / height > 2.2 or width > 3000
  ```
  The PNG uses `html-to-image`'s `toPng` with the React Flow transform computed from `getNodesBounds` + `getViewportForBounds` (the xyflow-documented export recipe). The PDF uses `jspdf` landscape: title + date at the top, the image scaled to fit, the legend at the bottom.

- [ ] **Step 1: Write failing tests** (mock `html-to-image` and `jspdf` with `vi.mock`): `pdfFormat` a4 vs a3 cases; `exportPdf` calls `addImage` once and `text` with the title and date, saved as `<filename>.pdf`; `exportPng` triggers a download named `<filename>.png`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core-front): PNG and PDF diagram export`.

### Task 8: Shared diagram canvas and task box

**Files:** Create `…/views/diagram/diagram-canvas.tsx`, `…/views/diagram/task-box.tsx`, `…/views/diagram/diagram-canvas.test.tsx`

**Interfaces:**
- Consumes: Tasks 2, 5, 6, 7.
- Produces:
  ```ts
  export const DIAGRAM_RECORD_CAP = 2000
  export function useDiagramRecords<T extends HasId>(entity: string, serverOptions: EntityListOptions | undefined, initialData: T[]): { records: T[]; capped: boolean; loading: boolean; error: string | null; reload: () => void }
  export interface DiagramCanvasProps {
    entity: string; mode: 'wbs' | 'pert'; title: string
    nodes: Node[]; edges: Edge[]                                  // positions are ignored: the canvas places them
    autoLayout: () => Record<string, Point>                        // called for unsaved boxes and by Re-arrange
    folded?: string[]; onFoldedChange?: (folded: string[]) => void
    onConnect?: (c: Connection) => void; onEdgesDelete?: (e: Edge[]) => void
    onNodeDrop?: (id: string, overId: string | null) => void      // WBS re-parent: the box under the dropped one
    legend: { color: string; label: string }[]
    toolbarExtra?: ReactNode
  }
  export function DiagramCanvas(props: DiagramCanvasProps): JSX.Element
  export interface TaskBoxData { record: Record<string, unknown>; editable: boolean; onCommit: (field: string, value: unknown) => Promise<void>; onOpen: () => void; badges?: ReactNode; footer?: ReactNode; chevron?: { folded: boolean; onToggle: () => void } }
  export function TaskBox(props: NodeProps<Node<TaskBoxData>>): JSX.Element
  ```
  The canvas loads the saved layout once (`getViewLayout`), gives saved positions to their nodes, places the rest with `autoLayout` and then `separateBoxes`, saved boxes `fixed`. On drag stop it runs `freeSpot` for the dropped box against the others (as `WorkflowMap.tsx` does) and schedules a debounced `saveViewLayout` with the positions of the ids currently present plus `folded`. The toolbar has Re-arrange (resets every position to `autoLayout()`, then saves), Export PNG, Export PDF, fit view, and the legend. `TaskBox` renders the five inline-editable fields (only those present on the record and in the descriptor) through the engine's existing field widgets, calls `onCommit` on blur/enter, reverts the value if it rejects, and calls `onOpen` on double-click.

- [ ] **Step 1: Write failing tests:** `merges saved positions with auto layout` (saved id keeps x/y, new id placed without overlap, stale saved id omitted from the next save payload); `saves debounced after a drag` (fake timers: two drags → one save after 500 ms); `re-arrange resets positions and saves`; `shows the cap notice above 2000` (`useDiagramRecords` with a mocked `listPage` returning full pages, probe non-empty → `capped: true`, notice text rendered, no React Flow); `TaskBox reverts on a rejected commit` (`onCommit` rejects → the old value is displayed again); `double-click opens`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core-front): shared diagram canvas with per-user layout and export`.

### Task 9: WBS mode

**Files:** Create `…/views/diagram/wbs-renderer.tsx`, `…/views/diagram/wbs-renderer.test.tsx`; modify `…/views/renderers.tsx` (dispatch beside the Gantt branch at ~line 1192: `mode === 'wbs' && effective.wbsParentField`)

**Interfaces:**
- Consumes: `buildWbs`, `canReparent` (Task 4), `layoutWbs` (Task 5), `DiagramCanvas`, `TaskBox`, `useDiagramRecords` (Task 8), `EntityActions.update`.
- Produces: `export function WbsRenderer<T extends HasId>(props: { descriptor: ViewDescriptor; initialData: T[]; actions: EntityActions<T>; parentField: string; groupField?: string; onRecordsChange: (r: T[]) => void; serverOptions?: EntityListOptions }): JSX.Element`

Group roots are read-only boxes labeled with the group's relation label. Every parent box gets a chevron (`TaskBox.chevron`). A folded box shows `+n tasks · h h` in its footer. Drop onto another box: `canReparent` false → snap back, no request; else `actions.update(id, {[parentField]: overId-is-group ? null : overId})`; a rejection → the error alert, the record and box revert. Tree edges are drawn parent → child (no arrowheads).

- [ ] **Step 1: Write failing tests:** `renders one root per group and tasks under parents`; `chevron folds and saves folded ids`; `reparents on drop` (update called with `{parent_id: 'B'}`); `drop on a group root clears the parent`; `refuses a drop on a descendant` (no update call); `reverts on a rejected reparent` (update rejects with a 422 → alert shown, `parent_id` unchanged in `onRecordsChange`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core-front): WBS view mode`.

### Task 10: PERT mode

**Files:** Create `…/views/diagram/pert-renderer.tsx`, `…/views/diagram/pert-renderer.test.tsx`; modify `…/views/renderers.tsx` (`mode === 'pert' && effective.pertDependencies`)

**Interfaces:**
- Consumes: `computePert`, `offsetToDate` (Task 3), `layoutPert` (Task 5), `DiagramCanvas`, `TaskBox`, `useDiagramRecords` (Task 8), `RelationOps.listPage/create/remove`.
- Produces: `export function PertRenderer<T extends HasId>(props: { descriptor: ViewDescriptor; initialData: T[]; actions: EntityActions<T>; dependencies: GanttDependenciesConfig; onRecordsChange: (r: T[]) => void; serverOptions?: EntityListOptions }): JSX.Element`

Links load like `gantt-renderer.tsx` (~line 471: `listPage(dep.entity, { in: { [toField]: ids } })`, paged). Each box shows ES/EF/LS/LF as dates (`offsetToDate`, workspace date format) and slack in days. A `No estimate` badge shows when flagged, and closed tasks are greyed. Critical boxes and links use `theme.palette.error.main`. A "n hidden links" chip goes in `toolbarExtra` when `hiddenLinks > 0`, and a cycle shows a warning alert with no critical highlighting. Connect → `create(dep.entity, {[fromField]: source, [toField]: target})`, then recompute. Edge delete → `remove(dep.entity, linkRowId)`. A failure → alert and revert. Value edits go through `actions.update`, and the PERT figures recompute from the updated records.

- [ ] **Step 1: Write failing tests:** `highlights the critical chain` (diamond fixture → critical class on A, B, D only); `shows no-estimate badge`; `shows hidden links count`; `creates a dependency on connect`; `deletes a dependency on edge delete`; `reverts on a rejected link` (create rejects 422 → alert, no new edge); `recomputes after editing planned hours` (update resolves with `planned_hours: 80` on C → C becomes critical).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(core-front): PERT view mode with critical path`.

### Task 11: Turn it on for Project, i18n, docs, full gate

**Files:**
- Modify: `core/modules/project/views/project_views.ts:147-158` (`taskViewModeDefaults` += `wbsParentField: 'parent_id'`, `wbsGroupField: 'project_id'`, `pertDependencies: { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' }`), `core/modules/project/views/project_views.test.ts`
- i18n: `core-front/apps/shell/i18n/fr.po` (engine msgids: `WBS`, `PERT`, `Re-arrange`, `Export PNG`, `Export PDF`, `Critical path`, `No estimate`, `hidden links`, `Earliest start`, `Earliest finish`, `Latest start`, `Latest finish`, `Slack`, the cap notice, the cycle warning); `core/modules/project/i18n/{project.pot,fr.po}` for any project-side label
- Create: `docs/adr/ADR-039-diagram-views.md` (why generic modes, per-user layouts, client-side export instead of `internal/reports`, and the PERT conventions: 8 h/day, calendar days, no estimate = 1 day)
- Modify: `CLAUDE.md` `core/modules/project` bullet (one sentence: the task lists' WBS/PERT modes, `wbsGroupField`, `pertDependencies`, link to ADR-039)

- [ ] **Step 1: Write failing test** in `project_views.test.ts`: `task lists enable wbs and pert` (asserts the three keys on every task list descriptor that uses `taskViewModeDefaults`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the descriptor change, i18n and docs. **Step 4: Run** → PASS.
- [ ] **Step 5: Run** `make test` → every stage green, coverage floors met. Fix any gap by adding tests, never by lowering a threshold.
- [ ] **Step 6:** `graphify update .`
- [ ] **Step 7: Commit** `feat(project): WBS and PERT views on task lists`.
- [ ] **Step 8: Manual check** with `make run`: open Project → All tasks → WBS (fold, drag, re-parent, edit hours, export PNG/PDF) and PERT (draw and delete an arrow, critical path turns red, reload keeps your layout, a second user sees their own).
