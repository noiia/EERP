# Project MS Project exchange (MSPDI XML) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Microsoft Project (MSPDI XML) as a second exchange format: export, plus import through the existing review wizard. Carry priority, notes, baselines and resource capacity, and offer the Export/Import menu in the Gantt, PERT and WBS modes.

**Architecture:** This is a second `Format` on the plan-1 pipeline. The shared pipeline gains format capabilities (`Carries`), so a format never "clears" a field it doesn't carry. The neutral `Plan` gains priority, notes, actual hours, baselines and resources, and the diff and apply steps gain the matching change kinds. The frontend extracts the plan-1 toolbar into an `ExchangeMenu`, reused by the diagram canvases.

**Tech Stack:** Go (`encoding/xml`), Next.js + MUI, vitest, Go tests on `testdb`.

**Spec:** `docs/superpowers/specs/2026-11-18-project-msproject-exchange-design.md` (builds on `docs/superpowers/specs/2026-11-18-project-gantt-exchange-design.md`)

**Prerequisite:** the GanttProject plan (`docs/superpowers/plans/2026-11-18-project-gantt-exchange.md`, epic #56) is fully merged into `dev`. Every name below marked *(plan 1)* comes from it.

## Global Constraints

- Every plan-1 Global Constraint still applies (routes, permissions, keys, 5000 cap, removals unticked, UTC-midnight dates, never writing trigger-maintained columns, i18n, `make test` with coverage floors).
- Format key `mspdi`, ext `.xml`, label `Microsoft Project (.xml)`, accept `.xml`. Export `Content-Type: application/xml`.
- Matching: the task extended attribute Text30 (`FieldName` `Text30`, alias `EERP id`; its `FieldID` is believed to be `188744006`: confirm it in Task 5 Step 6 from a file MS Project saves, and match on `FieldID` read from the file's `<ExtendedAttributes>` by `Alias`, never a hard-coded id). The value is the task uuid or `milestone:<uuid>`. The task `GUID` is set to the task uuid on export and ignored on import.
- Tasks are exported with `<Manual>1</Manual>`, `Start` at `T08:00:00`, `Finish` at `T17:00:00`, `Duration` = workdays × 8 h (`PT<h>H0M0S`), and `Work` = planned hours.
- Priority: export `1000` when `priority`, else `500`. Import: `> 500` → true.
- Capacity: `MaxUnits` = `hours_per_week / 40` (a user with no row → `1.0`). Import: `hours_per_week = MaxUnits × 40`, rounded to 0.01, valid in (0, 168] (else a warning and no row).
- Baselines: the newest 11 live EERP baselines → `Number` 0..10, with 0 the newest. An import only ever creates baselines: `baseline_create` key `baseline:<number>`, name `Baseline <number> (imported YYYY-MM-DD)`, ticked by default.
- Capacity rows: kind `capacity_update`, key `capacity:<email>`, `default_selected: false`.
- New change fields: `priority` and `description` (kind `update`, keys `task:<uuid>:priority` and `task:<uuid>:description`).
- Actual work: exported (`ActualWork` = `spent_hours`), ignored on import.
- `.mpp` is never uploaded. The wizard refuses it client-side with the "Save As → XML Format" message.

## Review Focus

1. **A `.gan` import after this plan.** It must produce no priority, description, baseline or capacity rows, because `.gan` doesn't carry them (Task 1: `TestDiff_FormatCarries`).
2. **An MSPDI file whose tasks MS Project switched to auto-scheduled.** Their dates may have moved. They show as normal date rows and must never crash (Task 5: `TestMspdiDecode_AutoScheduled`).
3. **A partner re-baselining Baseline 0 in MS Project.** That gives exactly one `baseline_create` row, and EERP's existing baselines are untouched (Task 4: `TestApply_BaselineCreateLeavesOthers`).
4. **A capacity change by a manager without capacity write permission.** Ticking it → 422 on that key, nothing applied (Task 4: `TestApply_CapacityNeedsPermission`).
5. **A very large Notes field or one holding RTF-like markup.** It is imported as plain text, capped at the description limit, with a `NAME_TRUNCATED`-style warning (`NOTES_TRUNCATED`) (Task 3: `TestDiff_LongNotesTruncated`).

---

## File map

| File | Responsibility |
|---|---|
| `core/modules/project/exchange.go` (modify) | `Field`, `Carries`, the Plan additions |
| `core/modules/project/gan.go` (modify) | `.gan`'s `Carries` |
| `core/modules/project/exchange_load.go` (modify) | load priority, notes, actual hours, baselines, resources |
| `core/modules/project/exchange_diff.go` (modify) | `Carries` filter, the new kinds |
| `core/modules/project/exchange_apply.go` (modify) | apply the new kinds |
| `core/modules/project/mspdi.go` (+ `_test`, `testdata/mspdi/*.xml`) | MSPDI codec |
| `core-front/packages/core-front/src/views/exchange/exchange-menu.tsx` (+ test) | Export/Import menu extracted from the Gantt toolbar |
| `core-front/packages/core-front/src/views/gantt-renderer.tsx`, `diagram/wbs-renderer.tsx`, `diagram/pert-renderer.tsx`, `renderers.tsx` (modify) | use the menu |
| `core-front/packages/core-front/src/views/exchange/import-wizard.tsx` (modify) | the new kinds, `.mpp` refusal |
| `core/modules/project/views/project_views.ts`, i18n, `docs/adr/ADR-042-project-plan-exchange.md`, `CLAUDE.md` | wiring and docs |

---

### Task 1: Format capabilities

**Files:**
- Modify: `core/modules/project/exchange.go`, `gan.go`, `exchange_diff.go`, and the callers of `diffPlans` (`exchange_apply.go`, `exchange_handler.go`)
- Test: `core/modules/project/exchange_diff_test.go`

**Interfaces:**
- Consumes: *(plan 1)* `Format`, `diffPlans`, `Change`.
- Produces:
  ```go
  type Field string
  const (FieldName Field = "name"; FieldDates = "dates"; FieldHours = "planned_hours"; FieldClosed = "closed"; FieldMilestone = "milestone_id"; FieldPriority = "priority"; FieldDescription = "description"; FieldBaselines = "baselines"; FieldCapacity = "capacity")
  // Format gains:
  Carries(f Field) bool
  // diffPlans becomes:
  func diffPlans(cur, file Plan, users map[string]uuid.UUID, f Format) ([]Change, []Warning)
  ```
  `ganFormat.Carries` is true for name, dates, planned_hours, closed and milestone_id.

- [ ] **Step 1: Write the failing test** `TestDiff_FormatCarries`. A cur and a file plan differ in name and in a field the fake format doesn't carry: a stub `Format` whose `Carries` returns true only for `FieldName`, with the same plans as `TestDiff_IdenticalIsEmpty` and the dates changed. Only the name row comes out. Update every existing `diffPlans` call in the tests to pass `ganFormat{}`.
- [ ] **Step 2: Run** `make run-back-tests BACKTESTPATH=./modules/project/... ARGS="-run TestDiff_"`. Expected: FAIL (signature).
- [ ] **Step 3: Implement.** Each field comparison in `diffPlans` is guarded by `f.Carries(...)`.
- [ ] **Step 4: Run** the whole package. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(project): exchange formats declare the fields they carry`

---

### Task 2: Plan additions and load

**Files:**
- Modify: `core/modules/project/exchange.go`, `exchange_load.go`
- Test: `core/modules/project/exchange_load_test.go`

**Interfaces:**
- Produces:
  ```go
  // PlanTask gains:
  Priority    bool
  Notes       string
  ActualHours float64 // export only

  type BaselineTask struct{ Start time.Time; Duration int; Work float64 }
  type PlanBaseline struct {
  	Number int                     // 0..10, 0 = newest
  	Tasks  map[string]BaselineTask // by task Key()
  }
  type PlanResource struct{ Email, Name string; HoursPerWeek float64 }

  // Plan gains:
  Baselines []PlanBaseline
  Resources []PlanResource // one per assignee email, plus every assignee's capacity
  ```
- `loadPlan` (*plan 1*) fills them:
  - `priority`, `description` and `spent_hours` from the task.
  - The newest 11 live `project_baseline` rows, ordered `created_at DESC, id`, numbered 0..10, with their `project_baseline_task` rows for live tasks. Dates use the same placeholder and workday rules as tasks.
  - `Resources`: one entry per distinct assignee email; `HoursPerWeek` = the user's live `project_capacity` row, else 40.

- [ ] **Step 1: Write failing tests:**
  - `TestLoadPlan_Extras`: a task with `priority` and a description; 12 baselines → 11 loaded, `Number 0` = the newest; an assignee with a 24 h capacity row and another with none (40).
  - `TestPlanHash_Extras`: changing a description changes the hash.
- [ ] **Step 2: Run** `… ARGS="-run 'TestLoadPlan|TestPlanHash'"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): exchange plans carry priority, notes, baselines and capacities`

---

### Task 3: Diff the new fields

**Files:**
- Modify: `core/modules/project/exchange_diff.go`
- Test: `core/modules/project/exchange_diff_test.go`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: the change kinds `baseline_create` (key `baseline:<n>`; After = `{name, tasks: <count>}`; `requires` = the create keys of new tasks it references) and `capacity_update` (key `capacity:<email>`; Task = the resource name; Before/After = hours per week). There is no new kind for priority or description: they are `update` rows, with `Field` `priority` and `description`.

Rules:
- **Priority**: compare booleans.
- **Description**: compare after trimming trailing whitespace and normalizing `\r\n` to `\n`. A file value over the description limit (the one `taskRules` enforces; reuse its constant) is truncated, with warning `NOTES_TRUNCATED`.
- **Baselines**: for each file baseline number, compare its task map with cur's same number (by key; Start, Duration, Work at 0.01). Any difference, or a number cur lacks → one `baseline_create` row. A file with fewer baselines than cur produces nothing (no deletes).
- **Capacity**: for each file resource with a known email whose `HoursPerWeek` differs from cur's → `capacity_update`, unticked. Out of (0, 168] → warning `CAPACITY_RANGE` and no row.

- [ ] **Step 1: Write failing tests:** `TestDiff_Priority`, `TestDiff_DescriptionNormalized` (a `\r\n`-only change → no row), `TestDiff_LongNotesTruncated` (Review Focus 5), `TestDiff_BaselineChangedIsCreate`, `TestDiff_BaselineMissingInFileIsNothing`, `TestDiff_BaselineRequiresNewTask`, `TestDiff_CapacityUnticked`, `TestDiff_CapacityRange`.
- [ ] **Step 2: Run** `… ARGS="-run TestDiff_"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): diff priority, notes, baselines and capacities`

---

### Task 4: Apply the new kinds

**Files:**
- Modify: `core/modules/project/exchange_apply.go`
- Test: `core/modules/project/exchange_apply_test.go`

**Interfaces:**
- Consumes: Task 3, *(plan 1)* `applyPlan`, `h.check`, `baselineLimit` (`baseline.go`), `h.perms` (`*auth.PermissionRepository`).
- Produces: no new exported names.

Rules, added to the plan-1 order:
- `priority`/`description` go through the field-update step (body keys `priority`/`description`, via `h.check` on `project_task`).
- `baseline_create` comes after the task creates and moves, before the deletes:
  - Count the live baselines on tx; at `baselineLimit` or more → 422 on the key.
  - Insert `ProjectBaseline{ProjectID, Name, CreatedBy: caller}`, then one `ProjectBaselineTask` per entry: `TaskID` from the key (or the new-task map), `DateStart` = Start, `Deadline` = `endAfter(Start, Duration, file.Weekend)`, `PlannedHours` = Work. Use the typed repos with `WithTx`.
  - This doesn't go through `h.check`: the baseline guards refuse every generic write, and the manager check already happened at the route.
- `capacity_update` comes last:
  - `h.perms.Has(ctx, user, "project_capacity:project_capacity:write")` false → 422 on the key.
  - Otherwise upsert the user's live `project_capacity` row on tx (an update if live, else a create).

- [ ] **Step 1: Write failing tests:**
  - `TestApply_PriorityAndDescription`.
  - `TestApply_BaselineCreateLeavesOthers` (Review Focus 3): a new baseline with the file's values; the existing ones are byte-identical.
  - `TestApply_BaselineLimit422`.
  - `TestApply_CapacityNeedsPermission` (Review Focus 4).
  - `TestApply_CapacityUpsert`: creates when absent, updates when live.
- [ ] **Step 2: Run** `… ARGS="-run TestApply_"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole package. Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): apply priority, notes, baselines and capacities from a file`

---

### Task 5: MSPDI codec

**Files:**
- Create: `core/modules/project/mspdi.go`
- Create: `core/modules/project/testdata/mspdi/basic.xml`, `partner_edited.xml`, `odd.xml`, `opened_saved.xml`
- Test: `core/modules/project/mspdi_test.go`

**Interfaces:**
- Consumes: Tasks 1–2, *(plan 1)* `registerFormat`, `endAfter`, `workdaysBetween`, `day`.
- Produces: `type mspdiFormat struct{}`; key `"mspdi"`, ext `".xml"`, `Carries` all fields; registered in `init()`.

**Format decisions** (namespace `http://schemas.microsoft.com/project`; verify in Step 6):

```xml
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>…</Name><CalendarUID>1</CalendarUID><MinutesPerDay>480</MinutesPerDay><MinutesPerWeek>2400</MinutesPerWeek>
  <ExtendedAttributes><ExtendedAttribute><FieldID>188744006</FieldID><FieldName>Text30</FieldName><Alias>EERP id</Alias></ExtendedAttribute></ExtendedAttributes>
  <Calendars><Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar>
    <WeekDays><WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>…(1 = Sunday … 7 = Saturday)…</WeekDays>
    <!-- exceptions: <Exceptions><Exception>… → HasHolidays --></Calendar></Calendars>
  <Tasks><Task>
    <UID>1</UID><ID>1</ID><GUID>…</GUID><Name>…</Name><Manual>1</Manual>
    <OutlineLevel>1</OutlineLevel><OutlineNumber>1</OutlineNumber><WBS>1</WBS>
    <Start>2026-01-05T08:00:00</Start><Finish>2026-01-09T17:00:00</Finish><Duration>PT40H0M0S</Duration>
    <Work>PT16H0M0S</Work><ActualWork>PT4H0M0S</ActualWork><PercentComplete>0</PercentComplete>
    <Priority>500</Priority><Milestone>0</Milestone><Summary>0</Summary><Notes>…</Notes>
    <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
    <ExtendedAttribute><FieldID>188744006</FieldID><Value>uuid</Value></ExtendedAttribute>
    <Baseline><Number>0</Number><Start>…</Start><Finish>…</Finish><Duration>…</Duration><Work>…</Work></Baseline>
  </Task></Tasks>
  <Resources><Resource><UID>1</UID><ID>1</ID><Name>Ann Lee</Name><EmailAddress>ann@x.com</EmailAddress><MaxUnits>1.00</MaxUnits></Resource></Resources>
  <Assignments><Assignment><UID>1</UID><TaskUID>1</TaskUID><ResourceUID>1</ResourceUID><Units>1</Units></Assignment></Assignments>
</Project>
```

- `UID 0` is MS Project's project summary task: skipped on decode, written on encode (`OutlineLevel 0`, `Summary 1`).
- Hierarchy is rebuilt from `OutlineLevel` + document order. `HasChildren` = `Summary == 1` or a following task has a deeper level.
- Dates are read from the date part of `Start`/`Finish`. `Duration` = `workdaysBetween(Start, Finish, Weekend)`. The `Duration` element is written but not read, so an auto-scheduled re-time still decodes.
- `LinkLag` is in tenths of minutes: `lag days = LinkLag / 4800` with `LagFormat 7` (days). Any non-zero value → `Lag != 0`, enough for the `DEP_LAG` warning.
- `Priority` > 500 → true. `MaxUnits` × 40 → `HoursPerWeek`. `Notes` is read as plain text.
- A `Milestone 1` task keeps its `Parent` as `""` (read at the top level), like `.gan`.

- [ ] **Step 1: Write the fixtures** by hand from the shape above. `basic.xml` mirrors `testdata/gan/basic.gan` (*plan 1*), plus 1 baseline, a priority task, a note, and a resource with `MaxUnits 0.6`. `partner_edited.xml`: a moved deadline, a new task, a removed task, a priority flip, a new Baseline 1. `odd.xml`: an SS link, an FS link with `LinkLag 9600`, a calendar exception, a task with `<Manual>0</Manual>` and moved dates, and a 6000-char note.
- [ ] **Step 2: Write failing tests:** `TestMspdiDecode_Basic` (the same assertions as *plan 1*'s `TestGanDecode_Basic`, plus priority, notes, baseline 0 and capacity 24), `TestMspdiDecode_AutoScheduled` (Review Focus 2: the `Manual 0` task decodes with its file dates), `TestMspdiDecode_Odd`, `TestMspdiRoundTrip`, `TestMspdiDecode_Malformed` (truncated, a DOCTYPE entity, the wrong root, the wrong namespace).
- [ ] **Step 3: Run** `… ARGS="-run TestMspdi"`. Expected: FAIL.
- [ ] **Step 4: Implement** with `encoding/xml` and `Strict = true`. Durations use a small `PT<h>H<m>M<s>S` parse/format pair; reject anything else with a decode error.
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Manual verification (needs MS Project; ProjectLibre only as a fallback, saying so in the PR).** Open `basic.xml`, check that the dates, outline, dependency, milestone, the "EERP id" column, Baseline 0 (Tracking Gantt), priority, the note and the resource's Max Units match, and that **no task moved** (manual scheduling). Save it as XML to `testdata/mspdi/opened_saved.xml`. Fix the codec if any tag differs. Add `TestMspdiDecode_OpenedSaved`: the same keys, names, deps and baselines as `basic.xml`.
- [ ] **Step 7: Commit** `feat(project): Microsoft Project XML (MSPDI) encoder and decoder`

---

### Task 6: Round trip and routes for MSPDI

**Files:**
- Test only: `core/modules/project/exchange_load_test.go`, `exchange_handler_test.go`

- [ ] **Step 1: Write the tests:**
  - `TestExport_ReimportIsEmpty_Mspdi`: *plan 1*'s project (weekend deadline, undated task, milestone link, dep, assignee), plus a priority task, a description, 2 baselines and a 24 h capacity. Export → decode → diff gives zero changes and zero warnings.
  - `TestExchange_MspdiExport`: 200, `Content-Disposition` ends `.xml"`, the body decodes.
  - `TestExchange_MspdiPreviewAndApply`: end to end with `partner_edited.xml`.
- [ ] **Step 2: Run** `… ARGS="-run 'ReimportIsEmpty_Mspdi|TestExchange_Mspdi'"`. Expected: PASS if Tasks 1–5 are right; otherwise fix the codec or the load side, not the test.
- [ ] **Step 3: Run** `make test` (Go part, coverage ≥ 85%). Expected: PASS.
- [ ] **Step 4: Commit** `test(project): MSPDI round trip and routes`

---

### Task 7: Frontend: shared menu, diagram modes, new change kinds

**Files:**
- Create: `core-front/packages/core-front/src/views/exchange/exchange-menu.tsx`, `exchange-menu.test.tsx`
- Modify: `gantt-renderer.tsx` (replace the plan-1 inline menu with `ExchangeMenu`), `diagram/wbs-renderer.tsx`, `diagram/pert-renderer.tsx` (an `exchange?: GanttExchangeConfig` prop + `serverOptions`, rendered through `DiagramCanvas`'s `toolbarExtra`), `renderers.tsx:1295-1325` (pass `exchange={effective.ganttExchange ?? undefined}` to both)
- Modify: `exchange/import-wizard.tsx`, `import-wizard.test.tsx`, `wbs-renderer.test.tsx`, `pert-renderer.test.tsx`, `gantt-renderer.test.tsx`

**Interfaces:**
- Consumes: *(plan 1)* `GanttExchangeConfig`, `ExchangeFormat`, `ImportWizard`, `pinnedId`, the `canImport` guard resolution.
- Produces: `export function ExchangeMenu(props: { config: GanttExchangeConfig; scopeId: string; variant: 'toolbar' | 'menuItems'; onImported: () => void }): JSX.Element`. `'toolbar'` renders the Export and Import buttons with their menus (Gantt desktop). `'menuItems'` renders `MenuItem`s, one "Export <label>" and one "Import <label>" per format (phone More menus and the diagram canvases' `toolbarExtra`, which sits inside the canvas' More menu).

Wizard additions:
- `baseline_create` row: the "Baseline" chip and `Create “<name>” (<n> tasks)`.
- `capacity_update` row: the resource name, `<before> h/week → <after> h/week`, and a "Workspace-wide" chip.
- `description` rows: before and after clamped to 3 lines, with "Show all" toggling the full text.
- File step: a picked name ending `.mpp` (case-insensitive) shows the exact message "MS Project's .mpp format can't be read. In MS Project, use File → Save As → XML Format, then pick that file." and sends no request.

- [ ] **Step 1: Write failing tests:**
  - `exchange-menu.test.tsx`: lists both formats in either variant; Import hidden when the guard is false; Export links to `/api/exchange/project/<id>/<key>/export`.
  - `wbs-renderer.test.tsx` and `pert-renderer.test.tsx`: a pinned project with `exchange` set shows "Export Microsoft Project (.xml)" in the canvas More menu; none without a pin.
  - `gantt-renderer.test.tsx`: the plan-1 tests still pass on the extracted menu.
  - `import-wizard.test.tsx`: renders `baseline_create` and `capacity_update` (with the chip, unticked); "Show all" expands a description; a `.mpp` pick shows the message and `fetch` isn't called.
- [ ] **Step 2: Run** `npx pnpm --filter @eerp/core-front vitest run src/views/exchange src/views/gantt-renderer.test.tsx src/views/diagram/wbs-renderer.test.tsx src/views/diagram/pert-renderer.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `rtk tsc` and `rtk lint`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(core-front): exchange menu in Gantt, WBS and PERT; MS Project change kinds`

---

### Task 8: Turn it on, i18n, docs

**Files:**
- Modify: `core/modules/project/views/project_views.ts`, `project_views.test.ts`, `core/modules/project/i18n/project.pot`, `fr.po` (+ the engine strings' catalogs), `docs/adr/ADR-042-project-plan-exchange.md`, `CLAUDE.md`

- [ ] **Step 1: Write the failing test.** In `project_views.test.ts`, `ganttExchange.formats` equals `[{ key: 'gan', label: 'GanttProject (.gan)', accept: '.gan' }, { key: 'mspdi', label: 'Microsoft Project (.xml)', accept: '.xml' }]`.
- [ ] **Step 2: Run** the module's vitest. Expected: FAIL.
- [ ] **Step 3: Add the format entry.** Add the msgids with French translations: Microsoft Project (.xml), Export <label>, Import <label>, Baseline, Create “<name>” (<n> tasks), Workspace-wide, h/week, Show all, and the `.mpp` message.
- [ ] **Step 4: Docs.** Add an "MS Project" section to ADR-042: MSPDI rather than `.mpp` (with the MPXJ alternative and why it was rejected), `Carries`, manual scheduling, baselines append-only, capacity workspace-wide and unticked, actual work export-only, and the shared-views table from the spec. Add one paragraph to the `CLAUDE.md` project bullet: the `mspdi` format key, the menu in Gantt/WBS/PERT, and the pitfalls (a format must declare `Carries`; `.mpp` isn't supported).
- [ ] **Step 5: Run** `make test`. Expected: PASS with every coverage floor met.
- [ ] **Step 6: Run** `graphify update .`
- [ ] **Step 7: Commit** `feat(project): Microsoft Project exchange on the task lists`
