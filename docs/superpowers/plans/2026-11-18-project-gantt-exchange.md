# Project Gantt exchange (.gan) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the pinned project's Gantt as a GanttProject `.gan` file and import a partner-edited one through a review wizard. The wizard shows one checkbox per change, with before → after, and applies the ticked changes in one transaction.

**Architecture:** Go reads and writes the file through a format-neutral `Plan` (`core/modules/project/exchange*.go`). The steps are: diff the current plan against the file's plan, then apply the ticked changes. Every write runs the project's existing validation rules, run on the import's transaction. The frontend adds a generic `ganttExchange` descriptor key, a BFF passthrough and an import wizard to the engine's Gantt renderer. Plan 2 (MS Project) adds one more `Format`.

**Tech Stack:** Go (`encoding/xml`, echo v5, core/orm), Next.js App Router + MUI (core-front engine package and shell), vitest, Go tests on `testdb`.

**Spec:** `docs/superpowers/specs/2026-11-18-project-gantt-exchange-design.md`

## Global Constraints

- Routes: `GET /api/v1/project/:id/exchange/:format/export`, `POST …/preview`, `POST …/apply`. The derived permissions are `project:project:read` / `project:project:write`, with no new permission.
- Export: anyone who sees the project, else 404. Preview/apply: the manager or an admin (`h.manages`). Invisible project → 404, others → 403.
- Unknown `:format` → 404. Over 5000 tasks → 422 `TOO_MANY_TASKS`. Not a `.gan` file → 422 `INVALID_FILE`. Stale `base` → 409 `PROJECT_CHANGED`. Inconsistent selection or validation failure → 422 with `fields` = the offending change keys.
- Preview/apply are upload routes: add `/api/v1/project/*/exchange` to `BodyLimitExempt` and give them `uploadLimit`.
- Custom `.gan` task columns: `eerp_id` (text: task uuid, or `milestone:<uuid>`) and `planned_hours` (double).
- Change keys, verbatim: `task:<uuid>:<field>`, `task:<uuid>:move`, `task:<uuid>:delete`, `new:<file id>`, `dep:<pred>:<succ>`, `dep:<pred>:<succ>:delete`, `assign:<task>:<email>`, `assign:<task>:<email>:delete`, `milestone:<uuid>:<field>`, `new-milestone:<file id>`, `milestone:<uuid>:delete`. A new task or milestone inside another key uses its own key (`new:<file id>`, `new-milestone:<file id>`).
- Removal rows (`…:delete`, and a `task:<uuid>:milestone_id` change to null) have `default_selected: false`. Everything else is `true`.
- Dates are whole days stored as UTC midnight in the `TIMESTAMPTZ` columns (as `baseline_test.go` asserts: `2026-01-05 00:00:00+00`).
- Hours compare at 0.01 precision. Completion maps only 100 ↔ closed.
- Undated placeholder: start = project `date_start`, else the task's `created_at` day. Duration 1 (0 for a milestone).
- Never write `wbs_number` (except through `taskOrder`), `blocked`, `closed`, `closed_at`, `spent_hours`, `subtask_*`, or the milestone counts.
- Every new UI string gets an entry in `core/modules/project/i18n/project.pot` and `fr.po` (engine strings: the shell catalogs where the engine's other strings live).
- `make test` must stay green, coverage floors included (core 85%, engine and shell 80%).
- Search with `rg`, never `grep`.

## Review Focus

1. **A file with a `<task>` that has no `eerp_id` but the same name as an existing task.** It must be a create, never a silent match by name (Task 5: `TestDiff_SameNameIsCreate`).
2. **A file re-imported twice in a row after a successful apply.** The second preview must show zero changes, because apply must write values that re-encode identically, including dates (Task 7: `TestApply_ThenPreviewIsEmpty`).
3. **A partner deleting a parent task in GanttProject.** That removes its subtasks from the file too. The parent's delete must `require` the subtask deletes, and ticking only the parent must still be refused (Task 5: `TestDiff_ParentDeleteRequiresChildren`, Task 7: `TestApply_ParentDeleteWithoutChildren422`).
4. **A malformed or hostile XML** (truncated, a billion-laughs entity, a 6000-task file). The result must be a 422 and never a panic or a hang (Task 3: `TestGanDecode_Malformed`, Task 8: `TestExchange_TooManyTasks`).
5. **A file exported from project A and imported into project B.** Every `eerp_id` is unknown there, so everything comes in as creates with a warning, and nothing in A is touched (Task 5: `TestDiff_ForeignIdsAreCreates`).

---

## File map

| File | Responsibility |
|---|---|
| `core/modules/project/validate.go` (modify) | `request.ex` executor, `(h *Handler) check(...)` entry for in-tx validation |
| `core/modules/project/workdays.go` (+ `_test`) | working-day arithmetic over a weekend mask |
| `core/modules/project/exchange.go` (+ `_test`) | `Plan`, `Format`, `Warning`, `Change`, the format registry |
| `core/modules/project/gan.go` (+ `_test`, `testdata/gan/*.gan`) | `.gan` encode/decode |
| `core/modules/project/exchange_load.go` (+ `_test`) | current EERP project → `Plan`, `planHash` |
| `core/modules/project/exchange_diff.go` (+ `_test`) | `diffPlans` → `[]Change`, minimal moves, removal dependents |
| `core/modules/project/exchange_apply.go` (+ `_test`) | apply ticked keys in one tx through `check` |
| `core/modules/project/exchange_handler.go` (+ `_test`) | the 3 routes |
| `core/modules/project/handler.go` (modify) | mount the routes |
| `core/internal/app/app.go` (modify) | `BodyLimitExempt` + `uploadLimit` for the exchange group |
| `core-front/packages/core-front/src/api/view-fields.ts` (modify) | `GanttExchangeConfig`, `ganttExchange` default |
| `core-front/packages/core-front/src/api/ApiClient.ts` (modify) | `proxyExchange` |
| `core-front/apps/shell/app/api/exchange/[[...path]]/route.ts` (+ test) | BFF passthrough |
| `core-front/apps/shell/proxy.ts` (modify) | skip `api/exchange` in the matcher |
| `core-front/packages/core-front/src/views/exchange/selection.ts` (+ test) | tick/untick with `requires` closure |
| `core-front/packages/core-front/src/views/exchange/import-wizard.tsx` (+ test) | the 3-step dialog |
| `core-front/packages/core-front/src/views/gantt-renderer.tsx`, `renderers.tsx` (modify) | Export menu + Import button |
| `core/modules/project/views/project_views.ts` (+ test) | `ganttExchange` on the task lists |
| `docs/adr/ADR-042-project-plan-exchange.md`, `CLAUDE.md` | docs |

---

### Task 1: Validation rules run on any executor

**Files:**
- Modify: `core/modules/project/validate.go` (the `request` struct; the 23 `r.h.db` / `h.db` uses inside rules, `load`, `row`, `manages`)
- Test: `core/modules/project/validate_tx_test.go`

**Interfaces:**
- Produces:
  - `request.ex orm.Executor`. Every rule queries through `r.ex`, never `r.h.db`.
  - `func (h *Handler) managesOn(ctx context.Context, ex orm.Executor, tenant, user, pid uuid.UUID) (bool, error)`. The existing `h.manages` calls it with `h.db`.
  - `func (h *Handler) rowOn(ctx context.Context, ex orm.Executor, table string, id, tenant uuid.UUID, live bool) (map[string]any, error)`. `h.row` calls it with `h.db`.
  - `func (h *Handler) check(ctx context.Context, ex orm.Executor, table string, o op, id uuid.UUID, body map[string]any) (map[string]any, error)`. It reads the caller (`auth.IdentityFromContext`) and tenant from ctx. For update/delete it checks visibility (`orm.CanSeeRecord(ctx, ex, …)`, else `errNotFound`) and loads `stored` via `rowOn`. Then it runs `rulesByTable[table]` and returns the (possibly rewritten) body.
  - `var rulesByTable = map[string]func(*request) error{"project_task": taskRules, "project_task_dependency": dependencyRules, "project_task_user": userLinkRules, "project_milestone": milestoneRules}`.

- [ ] **Step 1: Write the failing test** `TestCheck_SeesRowsOfItsTransaction`. In `orm.Transact`, insert a task T1 in project P (managed by caller m) on `tx`. Then `h.check(ctx, tx, "project_task", opCreate, uuid.Nil, {"project_id": P, "name": "child", "parent_id": T1})` must return nil error and a body with `stage_id` set to P's first stage. Outside the tx (`h.db`), the same check must return a 422 rejection on `parent_id`. Also add `TestCheck_ManagerOnly`: `check` on `project_task_dependency` delete by a non-manager non-assignee of a members-only project returns `errNotFound`.
- [ ] **Step 2: Run** `make run-back-tests BACKTESTPATH=./modules/project/... ARGS="-run TestCheck_ -v"`. Expected: FAIL, `h.check undefined`.
- [ ] **Step 3: Implement.** Add the field and route every query in rules through `r.ex`. `load` sets `ex: h.db`. Add `managesOn`, `rowOn`, `check` and `rulesByTable`. This is a mechanical change: no rule's logic changes.
- [ ] **Step 4: Run** the whole package: `make run-back-tests BACKTESTPATH=./modules/project/...`. Expected: PASS, including every pre-existing validate/scope/order test.
- [ ] **Step 5: Run** `cd core && golangci-lint run ./modules/project/...`. Expected: no issues.
- [ ] **Step 6: Commit** `refactor(project): validation rules run on any executor`

---

### Task 2: Neutral plan model and working days

**Files:**
- Create: `core/modules/project/exchange.go`, `core/modules/project/workdays.go`
- Test: `core/modules/project/workdays_test.go`, `core/modules/project/exchange_test.go`

**Interfaces:**
- Produces (exact):

```go
type Weekend [7]bool // indexed by time.Weekday; true = not worked

var DefaultWeekend = Weekend{time.Saturday: true, time.Sunday: true}

func workdaysBetween(start, end time.Time, w Weekend) int        // inclusive count of worked days; ≥ 1 when end ≥ start (a weekend-only span counts 1)
func endAfter(start time.Time, duration int, w Weekend) time.Time // the day of the duration-th worked day from start (start itself counts if worked); duration ≤ 1 → start
func day(t time.Time) time.Time                                   // UTC midnight of t's UTC date

type DepType int
const (DepFS DepType = iota; DepSS; DepFF; DepSF)

type PlanTask struct {
	Ref          string    // EERP uuid, "milestone:<uuid>", or "" when new
	FileID       string    // file-local id ("" on a loaded plan)
	Name         string
	Parent       string    // Key() of the parent, "" at top level
	Start        time.Time // day()
	Duration     int       // working days; 0 for a milestone
	PlannedHours float64
	Complete     int       // 0..100
	Milestone    bool
	Undated      bool      // loaded plan only: Start/Duration are the placeholder
	HasChildren  bool
}
func (t PlanTask) Key() string // Ref when set; else "new:"+FileID, or "new-milestone:"+FileID for a milestone

type PlanDep struct{ Pred, Succ string; Type DepType; Lag int } // Pred/Succ are Key()s
type PlanAssign struct{ Task, Email, Name string }             // Task is a Key()

type Plan struct {
	Name        string
	Weekend     Weekend
	HasHolidays bool
	Tasks       []PlanTask // document order (pre-order); milestones after the tasks
	Deps        []PlanDep
	Assignments []PlanAssign
}

type Warning struct {
	Code    string `json:"code"`    // UNKNOWN_ID, DUPLICATE_ID, DEP_TYPE, DEP_LAG, DEP_FROM_MILESTONE, MULTI_MILESTONE, UNKNOWN_EMAIL, NAME_TRUNCATED, HOLIDAYS
	Message string `json:"message"`
	Task    string `json:"task,omitempty"` // the file task's name
}

type Format interface {
	Key() string
	Ext() string // ".gan"
	Encode(w io.Writer, p Plan) error
	Decode(r io.Reader) (Plan, []Warning, error) // error = not this format (→ 422 INVALID_FILE)
}

func registerFormat(f Format)            // called from init() of each format file
func formatByKey(key string) (Format, bool)
```

- [ ] **Step 1: Write failing tests** `TestWorkdays` (table-driven). Mon 2026-01-05 → Fri 2026-01-09 = 5. Fri → Mon = 2. Sat → Sun = 1. `endAfter(Mon, 5) = Fri`, `endAfter(Fri, 2) = Mon`, `endAfter(Sat, 1) = Sat`, `endAfter(x, 0) = x`. A weekend mask with Friday off: Mon → Fri = 4. Then `TestPlanTaskKey`: `{Ref:"u"}` → `"u"`, `{FileID:"7"}` → `"new:7"`, `{FileID:"7", Milestone:true}` → `"new-milestone:7"`.
- [ ] **Step 2: Run** `make run-back-tests BACKTESTPATH=./modules/project/... ARGS="-run 'TestWorkdays|TestPlanTaskKey'"`. Expected: FAIL (undefined).
- [ ] **Step 3: Implement** the two files. Use a simple day loop: spans are bounded by the 5000-task × project-length scale.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): neutral plan model for exchange formats`

---

### Task 3: GanttProject `.gan` format

**Files:**
- Create: `core/modules/project/gan.go`
- Create: `core/modules/project/testdata/gan/basic.gan`, `partner_edited.gan`, `odd.gan`, `opened_saved.gan`
- Test: `core/modules/project/gan_test.go`

**Interfaces:**
- Consumes: Task 2's types, `registerFormat`.
- Produces: `type ganFormat struct{}` registered as key `"gan"`, ext `".gan"`.

**Format decisions** (GanttProject 3.x; verify against a real file in Step 6):

```xml
<project name="…" version="3.2" locale="en_US">
  <calendars><day-types><day-type id="0"/><day-type id="1"/>
    <default-week id="1" name="default" sun="1" mon="0" tue="0" wed="0" thu="0" fri="0" sat="1"/>
  </day-types><!-- holidays: <date year="" month="" date="" type="HOLIDAY"/> --></calendars>
  <tasks empty-milestones="true">
    <taskproperties>
      <taskproperty id="tpc0" name="eerp_id" type="custom" valuetype="text"/>
      <taskproperty id="tpc1" name="planned_hours" type="custom" valuetype="double"/>
    </taskproperties>
    <task id="1" name="…" meeting="false" start="2026-01-05" duration="5" complete="0" expand="true">
      <depend id="2" type="2" difference="0" hardness="Rubber"/>   <!-- on the PREDECESSOR; id = successor -->
      <customproperty taskproperty-id="tpc0" value="<uuid>"/>
      <customproperty taskproperty-id="tpc1" value="16.0"/>
      <task …/>  <!-- children nest -->
    </task>
  </tasks>
  <resources><resource id="1" name="Ann Lee" function="Default:0" contacts="ann@x.com" phone=""/></resources>
  <allocations><allocation task-id="1" resource-id="1" function="Default:0" responsible="true" load="100.0"/></allocations>
</project>
```

- Depend `type`: 1 = SS, 2 = FS, 3 = FF, 4 = SF. `difference` = lag in days.
- On decode, find the custom properties **by `name`** (`eerp_id`, `planned_hours`), not by id, because GanttProject may renumber them.
- On decode, `HasChildren` = the element has child `<task>` elements. A `meeting="true"` task is `Milestone`. Its `Parent` is set to `""` (milestones are read at the top level). A `Ref` read from a milestone's `eerp_id` keeps its `milestone:` prefix.
- On encode: task ids are 1..n in document order, milestones come last at the top level, `hardness="Rubber"`, and `complete` is 100 or 0 as given.

- [ ] **Step 1: Write the fixtures** by hand from the shape above. `basic.gan`: 2 parents, 3 children, 1 FS dep, 1 milestone with a task → milestone dep, 1 resource and allocation. `partner_edited.gan`: basic with one deadline moved, one new task (no `eerp_id`), one task removed, one dep added. `odd.gan`: an SS dep, an FS dep with `difference="2"`, a dep from a milestone, a `HOLIDAY` date, a 250-char name, a duplicate `eerp_id`. `opened_saved.gan` is filled in Step 6.
- [ ] **Step 2: Write failing tests:**
  - `TestGanDecode_Basic`: 6 tasks in pre-order. Children carry their parent's `Key()`. The milestone has `Milestone: true`, `Parent: ""` and `Ref: "milestone:…"`. `PlannedHours` comes from the custom column. 2 deps, both `DepFS`, the second with `Succ` = the milestone key. 1 assignment with `Email: "ann@x.com"`. `Weekend == DefaultWeekend`.
  - `TestGanDecode_Odd`: `Weekend` read, `HasHolidays == true`, the deps keep `DepSS` and `Lag: 2`. (The warnings for those come from the diff, Task 5; decode returns only `HOLIDAYS`.)
  - `TestGanRoundTrip`: `Decode(Encode(p))` deep-equals `p` (FileIDs aside) for a plan built in code with all fields set.
  - `TestGanDecode_Malformed`: truncated XML, a `<!DOCTYPE` with entity expansion, and a non-`<project>` root each return an error, within the test's default timeout. Go's `encoding/xml` does not expand external or custom entities. Assert that it errors instead of expanding.
- [ ] **Step 3: Run** `make run-back-tests BACKTESTPATH=./modules/project/... ARGS="-run TestGan"`. Expected: FAIL.
- [ ] **Step 4: Implement** `gan.go` with `encoding/xml` structs mirroring the shape above. Use `xml.Decoder` with `Strict = true`.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Manual verification (needs GanttProject 3.x installed; ask the user if it isn't).** Open `basic.gan` in GanttProject, check the hierarchy, dates, dependency, milestone and custom columns, then save it unchanged as `testdata/gan/opened_saved.gan`. If GanttProject changed any tag or attribute the decoder relies on, fix `gan.go` and re-run Step 5. Add `TestGanDecode_OpenedSaved`, which asserts that the decode of `opened_saved.gan` has the same task keys, names and deps as `basic.gan`.
- [ ] **Step 7: Commit** `feat(project): GanttProject .gan encoder and decoder`

---

### Task 4: Load the current project as a Plan

**Files:**
- Create: `core/modules/project/exchange_load.go`
- Test: `core/modules/project/exchange_load_test.go`

**Interfaces:**
- Consumes: Task 2's types and `workdaysBetween`. The fixture helpers in `scope_test.go`.
- Produces:
  - `func loadPlan(ctx context.Context, ex orm.Executor, tenant, pid uuid.UUID, w Weekend) (Plan, error)`
  - `func planHash(p Plan) string`: hex sha256 of a canonical JSON of `p`, with tasks sorted by Key, deps by `Pred+Succ`, assignments by `Task+Email`. This is the `base`.

Rules:
- Live tasks of the project, ordered by `wbs_number` (natural numeric order of the dotted parts). `Ref` = id. `Parent` = `parent_id`.
- `Start` = `day(date_start)`. `Duration` = `workdaysBetween(date_start, deadline)`.
- With only one of the two dates set, the missing one equals the other. With neither, use the placeholder (Global Constraints) and set `Undated: true`.
- `Complete` = 100 if `closed`, else 0. `HasChildren` = it has live subtasks.
- Live milestones come after the tasks: `Ref` = `milestone:<id>`, `Duration` 0, `Start` = `deadline`, else the placeholder.
- `Deps` = live dependencies with **both ends in the project** (DepFS, Lag 0), plus one `{Pred: task, Succ: "milestone:"+milestone_id}` per live task with a `milestone_id`.
- `Assignments` = live `project_task_user` rows joined to `users` for the email and display name (`display_name`, else `name surname`, else the email).

- [ ] **Step 1: Write failing tests:**
  - `TestLoadPlan`: a project with a parent and 2 children (one dated Mon–Fri → `Duration 5`, one undated → `Undated`, `Start` = the project's `date_start`), a cross-project dependency (absent from `Deps`), an in-project dependency (present), a milestone linked from one task (a dep to `milestone:<id>`), and one assignee (with email).
  - `TestPlanHash_Stable`: the same project loaded twice has an equal hash. After one deadline update the hash differs.
- [ ] **Step 2: Run** `… ARGS="-run 'TestLoadPlan|TestPlanHash'"`. Expected: FAIL.
- [ ] **Step 3: Implement** with plain SQL through `ex` (tenant-pinned, `deleted_at IS NULL`).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): load a project as an exchange plan`

---

### Task 5: Diff

**Files:**
- Create: `core/modules/project/exchange_diff.go`
- Test: `core/modules/project/exchange_diff_test.go`

**Interfaces:**
- Consumes: Tasks 2 and 4.
- Produces:

```go
type Dependents struct {
	Subtasks   int `json:"subtasks"`
	Timesheets int `json:"timesheets"`
	RiskLinks  int `json:"risk_links"`
}

type Change struct {
	Key             string      `json:"key"`
	Kind            string      `json:"kind"` // create | update | move | delete | dependency | dependency_delete | assign | assign_delete | milestone_create | milestone_update | milestone_delete
	Task            string      `json:"task"` // the task's or milestone's name (the file's for creates)
	Wbs             string      `json:"wbs,omitempty"`
	Field           string      `json:"field,omitempty"` // name | dates | planned_hours | closed | milestone_id | parent (move)
	Before          any         `json:"before"`
	After           any         `json:"after"`
	DefaultSelected bool        `json:"default_selected"`
	Requires        []string    `json:"requires,omitempty"`
	WasUnscheduled  bool        `json:"was_unscheduled,omitempty"`
	Dependents      *Dependents `json:"dependents,omitempty"` // task deletes only
}

// cur: loaded with the FILE's weekend. users: lower(email) → user id (staff only, live).
func diffPlans(cur, file Plan, users map[string]uuid.UUID) ([]Change, []Warning)
func removalDependents(ctx context.Context, ex orm.Executor, tenant uuid.UUID, tasks []uuid.UUID) (map[uuid.UUID]Dependents, error)
```

Rules (from the spec):
- **Matching.** A file task matches when its `Ref` is a key in `cur`. An unknown `Ref` → treated as new, with warning `UNKNOWN_ID`. A second file task with the same `Ref` → new, with `DUPLICATE_ID`. Only `Ref` matches, never the name.
- **Field updates** compare encoded values:
  - `name`: a name over 200 runes is truncated, with `NAME_TRUNCATED`.
  - `dates`: one row holding `{start, end}`, Before/After as `"2006-01-02"` strings, where end = `endAfter(Start, Duration)`. It is emitted when `Start` or `Duration` differ. It is skipped when the file task `HasChildren`. It carries `WasUnscheduled` when the cur task is `Undated`.
  - `planned_hours`: compared at 0.01.
  - `closed`: a row only when the file crosses 100 in either direction, skipped when `HasChildren`. Before/After are booleans.
- **Moves.** For each matched task, compare the parent. For each parent's children, keep the matched tasks present in both. The tasks outside the longest common subsequence of the two orders get a `move` row (After = `{parent, after}`: the parent's key and the preceding sibling's key in the file, or null). A parent change is always a move. A move whose new parent or preceding sibling is new `requires` that create's key.
- **Creates.** One `create` row per new task (After = `{name, parent, start, end, planned_hours}`). It `requires` a new parent's key. A new milestone is `milestone_create`.
- **Deletes.** A cur task missing from the file → `delete`, unticked, with `requires` = the delete keys of its cur subtasks that are also missing (all of them, since the file lost the subtree). A missing milestone → `milestone_delete`.
- **Dependencies.** Only `DepFS` with `Lag == 0` (any other type → `DEP_TYPE`; FS with a lag → `DEP_LAG`, imported as FS). A dep whose `Pred` is a milestone → `DEP_FROM_MILESTONE`, skipped.
  - A dep whose `Succ` is a milestone sets `milestone_id`: an `update` row with `Field: "milestone_id"`, keyed `task:<uuid>:milestone_id`. A new task gets it inside its create's After instead. A second milestone successor → `MULTI_MILESTONE`, and the first one wins.
  - Other deps: added → `dependency`, removed → `dependency_delete` (unticked). A removed milestone link → a `milestone_id` update to null (unticked).
  - `requires` lists the key of any new end.
- **Assignees.** An unknown email → `UNKNOWN_EMAIL`, no row. Added → `assign`. Removed → `assign_delete` (unticked). A new task end goes in `requires`.
- **Order.** Rows are ordered by the file's task order: cur `wbs_number` for matched tasks, deletes after their former neighbours. Within a task, the order is create/move/updates/deps/assigns/delete.

- [ ] **Step 1: Write failing tests** (pure, plans built in code):
  - `TestDiff_IdenticalIsEmpty`: `diffPlans(p, p)` returns no changes and no warnings.
  - `TestDiff_WeekendDeadlineStable`: cur has Mon → Sat (Duration 5 under the default weekend), and the file has the same Start and Duration. No row.
  - `TestDiff_UndatedPlaceholderStable`, and `TestDiff_UndatedMovedIsWasUnscheduled`.
  - `TestDiff_SummaryDatesIgnored`: a parent's dates and completion differ in the file, and there is no row.
  - `TestDiff_SameNameIsCreate` (Review Focus 1). `TestDiff_ForeignIdsAreCreates` (Review Focus 5): every file task is a create, with one `UNKNOWN_ID` warning per task. Cur's tasks are missing from the file, so their delete rows are present, and each one has `DefaultSelected == false`.
  - `TestDiff_InsertAtTopNoMoves`: inserting one new task first gives exactly one `create` row and zero `move` rows.
  - `TestDiff_SwapTwoIsOneMove`.
  - `TestDiff_ParentDeleteRequiresChildren` (Review Focus 3).
  - `TestDiff_DepKinds`: SS → warning only. FS lag 2 → a `dependency` row plus a `DEP_LAG` warning. From a milestone → a warning. Task → milestone → a `milestone_id` row.
  - `TestDiff_RemovalsUnticked`: every `*_delete` and every null `milestone_id` row has `DefaultSelected == false`, and the rest have `true`.
  - `TestDiff_RequiresNewEnds`: a dep from a new task requires `new:<id>`.
  - `TestDiff_UnknownEmail`.
- [ ] **Step 2: Run** `… ARGS="-run TestDiff_"`. Expected: FAIL.
- [ ] **Step 3: Implement** `diffPlans`. The LCS over each parent's children is O(n·m) per parent, which is fine at ≤ 5000 tasks. Add `removalDependents` as one query per count, with `= ANY($2)`.
- [ ] **Step 4: Add** `TestRemovalDependents` (DB): a task with 2 timesheets, 1 risk link and 3 subtasks → `{3, 2, 1}`, counting live rows only.
- [ ] **Step 5: Run** `… ARGS="-run 'TestDiff_|TestRemovalDependents'"`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(project): diff an exchange file against the project`

---

### Task 6: Encode for export

**Files:**
- Modify: `core/modules/project/exchange_load.go` (no new file)
- Test: `core/modules/project/exchange_load_test.go`

**Interfaces:**
- Produces: `func exportPlan(ctx context.Context, ex orm.Executor, tenant, pid uuid.UUID) (Plan, error)` = `loadPlan` with `DefaultWeekend` and `Name` = the project's name. Export writes `format.Encode(w, exportPlan(...))`.

- [ ] **Step 1: Write the failing test** `TestExport_ReimportIsEmpty` (Goal 5). Build a project containing a weekend deadline, an undated task, a milestone with a link, a dep and an assignee. Then `exportPlan` → `ganFormat.Encode` → `Decode` → `diffPlans(loadPlan(…, file.Weekend), file, users)` returns zero changes and zero warnings.
- [ ] **Step 2: Run.** Expected: FAIL until the encode and load details line up. Fix whichever side is wrong.
- [ ] **Step 3: Run.** Expected: PASS.
- [ ] **Step 4: Commit** `feat(project): export a project as a plan`

---

### Task 7: Apply

**Files:**
- Create: `core/modules/project/exchange_apply.go`
- Test: `core/modules/project/exchange_apply_test.go`

**Interfaces:**
- Consumes: Task 1 `h.check`, Tasks 4–5.
- Produces: `func (h *Handler) applyPlan(ctx context.Context, tenant, pid uuid.UUID, file Plan, base string, keys []string, users map[string]uuid.UUID, filename string) (int, error)`. It returns the number of changes applied. Its errors: `conflictChanged` (409 `PROJECT_CHANGED`), or a `*rejection` 422 whose `fields` = keys.

Algorithm, all inside one `orm.Transact`:
1. Lock the project row (`SELECT … FROM project WHERE id = $1 FOR UPDATE`). Run `loadPlan(tx, file.Weekend)`. If `planHash ≠ base` → 409.
2. Compute `diffPlans`. Any requested key that isn't in it → 422 naming it. Any requested key whose `Requires` aren't all requested → 422 naming both.
3. Writes, in order. Each write builds a body, runs `h.check(ctx, tx, table, op, id, body)`, then persists the returned body:
   - Creates go through the typed repos (`orm.MustRepo[ProjectTask](h.db).WithTx(tx).Create`, same for `ProjectMilestone`, `ProjectTaskDependency`, `ProjectTaskUser`), after `json` round-tripping the body into the struct.
   - Updates use `UpdateQuery().Set(col, v)…Where(id, tenant).Exec(ctx, tx)` over the body's keys.
   - Deletes set `deleted_at = now()` the same way.
   - A new key's uuid is kept in a `map[string]uuid.UUID` so later rows resolve `new:<id>`.

   The order:
   1. Task creates, in file order (parents first). Body `{project_id, name, parent_id, date_start, deadline, planned_hours, milestone_id}`; dates come from Start and `endAfter`.
   2. Milestone creates.
   3. Moves and position. For each file parent, the final sibling order is the file order restricted to the tasks that will be there: matched tasks that aren't deleted, plus ticked creates. For each ticked move or create in that order, write `{parent_id, sequence: <1-based index>}`.
   4. Field updates. `dates` → `date_start`/`deadline`. `closed` → `stage_id` = the project's first closed stage (`sequence` order) or first open stage; no such stage → 422 on the key.
   5. Milestone updates.
   6. Dependency and assignee creates.
   7. Deletes: deps, assignees, then tasks deepest-first, then milestones. A milestone delete first runs `UPDATE project_task SET milestone_id = NULL WHERE milestone_id = $1` on tx.
4. A chatter `kind: "log"` message on `(project, pid)`: "Imported <filename>: <n> changes". Use `internal/chatter`'s repository the same way other modules post a log, inside the tx.
5. Any rule rejection is returned as a 422 with `fields: [the key being applied]`.

- [ ] **Step 1: Write failing tests:**
  - `TestApply_Subset`: preview `partner_edited.gan` against a project built to match `basic.gan`, tick only the moved-deadline key, apply. Only that deadline changed.
  - `TestApply_ThenPreviewIsEmpty` (Review Focus 2): apply every key, then diff again with the same file. Zero changes, apart from the unticked removals, which reappear identically (assert that only `*_delete` kinds remain).
  - `TestApply_StaleBase409`.
  - `TestApply_MissingRequires422`: a dep on a new task without its create.
  - `TestApply_ParentDeleteWithoutChildren422` (Review Focus 3).
  - `TestApply_CycleIs422WithKey`: a file adding A → B while B → A exists, and a tick on the add.
  - `TestApply_AllOrNothing`: one failing key in the middle → nothing persisted.
  - `TestApply_MilestoneDeleteClearsLinks`.
  - `TestApply_ClosedMovesStage`.
  - `TestApply_ChatterLog`.
- [ ] **Step 2: Run** `… ARGS="-run TestApply_"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run the whole package. Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): apply selected exchange changes in one transaction`

---

### Task 8: Routes

**Files:**
- Create: `core/modules/project/exchange_handler.go`
- Modify: `core/modules/project/handler.go` (`Mount`: 3 routes; `Mount` gains a trailing `upload echo.MiddlewareFunc` parameter, or the routes take it from a `MountExchange(e, upload, mw...)`: use `MountExchange` so `Mount`'s callers don't change)
- Modify: `core/internal/app/app.go:311` (`BodyLimitExempt` += `"/api/v1/project/*/exchange"`), and call `projectHandler.MountExchange(srv.Echo(), uploadLimit, <same mw as Mount>)`
- Test: `core/modules/project/exchange_handler_test.go`, `core/internal/app/app_test.go` (route table)

**Interfaces:**
- Produces: `func (h *Handler) MountExchange(e *echo.Echo, upload echo.MiddlewareFunc, mw ...echo.MiddlewareFunc)`.
  - `GET  /api/v1/project/:id/exchange/:format/export` → 200 file, `Content-Type: application/xml`, `Content-Disposition: attachment; filename="<project name><ext>"` (name sanitized to `[\w .-]`, else `project`).
  - `POST …/preview` (multipart `file`) → `{"base": string, "changes": []Change, "warnings": []Warning}`.
  - `POST …/apply` (multipart `file`, `base`, `keys` repeated) → `{"applied": n}`.
  - Users map: live staff users of the tenant (`users.kind <> 'website'`), keyed by `lower(email)`.

- [ ] **Step 1: Write failing tests** (multipart helper next to `f.do`):
  - `TestExchange_Export`: the manager gets 200 with the attachment header, and the body decodes. A member of an `everyone` project gets 200. An invisible project → 404. `:format = "xyz"` → 404.
  - `TestExchange_PreviewPermissions`: the manager → 200, an admin → 200, a non-manager viewer → 403, invisible → 404.
  - `TestExchange_PreviewAndApply`: end to end with `partner_edited.gan`.
  - `TestExchange_InvalidFile`: a PNG → 422 `INVALID_FILE`.
  - `TestExchange_TooManyTasks` (Review Focus 4): a generated 5001-task file → 422 `TOO_MANY_TASKS`.
  - `TestExchange_RemovalDependents`: the preview's delete row carries `dependents`.
  - In `core/internal/app/app_test.go`'s route table: `{GET, "/api/v1/project/<zero uuid>/exchange/gan/export", nil, 404}`.
- [ ] **Step 2: Run** `make run-back-tests BACKTESTPATH=./modules/project/... ARGS="-run TestExchange_"` and `BACKTESTPATH=./internal/app/...`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `respond`. Preview: decode → `len(Tasks) > 5000` → 422 → `loadPlan` (`h.db`, the file's weekend) → `diffPlans` → fill `Dependents` on delete rows → JSON.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Run** `make test` (the Go part at least: coverage ≥ 85%). Expected: PASS.
- [ ] **Step 6: Commit** `feat(project): exchange export, preview and apply routes`

---

### Task 9: BFF passthrough and descriptor config

**Files:**
- Modify: `core-front/packages/core-front/src/api/ApiClient.ts` (next to `proxyTeams`)
- Create: `core-front/apps/shell/app/api/exchange/[[...path]]/route.ts`, `route.test.ts`
- Modify: `core-front/apps/shell/proxy.ts:33` (add `api/exchange` to the matcher's skip list, and to the comment above it)
- Modify: `core-front/packages/core-front/src/api/view-fields.ts` (type, `ViewModeDefaults.ganttExchange`, the effective config at ~275/313)
- Test: `core-front/packages/core-front/src/api/view-fields.test.ts`

**Interfaces:**
- Produces:
  - `export async function proxyExchange(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response>` → `fetchWithRefresh(method, path, null, body)`, where `path` = `/<scopeEntity>/<id>/exchange/<format>/<action>`.
  - BFF: `/api/exchange/<scopeEntity>/<id>/<format>/<action>` → Go `/api/v1/<scopeEntity>/<id>/exchange/<format>/<action>`. It accepts only `action ∈ {export, preview, apply}` and exactly 4 segments, else 400. It is the teams route's shape: multipart passthrough, streamed body, `Content-Disposition` relayed.
  - ```ts
    export interface ExchangeFormat { key: string; label: string; accept: string }
    export interface GanttExchangeConfig {
      scopeField: string      // 'project_id'
      scopeEntity: string     // 'project'
      formats: ExchangeFormat[]
      canImport?: string      // a registered guard name, e.g. 'project.canEditStages'
    }
    ```
    `ViewModeDefaults.ganttExchange?: GanttExchangeConfig`, effective `ganttExchange: GanttExchangeConfig | null`.

- [ ] **Step 1: Write failing tests:** `route.test.ts` (mirroring the teams route's test): GET export relays the status, body and `Content-Disposition`. POST multipart is forwarded as FormData. `..` → 400. A 3-segment path → 400. `action=delete` → 400. In `view-fields.test.ts`: `ganttExchange` defaults to `null`, and a set config passes through.
- [ ] **Step 2: Run** `cd core-front && npx pnpm --filter shell vitest run app/api/exchange` and `npx pnpm --filter @eerp/core-front vitest run src/api/view-fields.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core-front): exchange BFF passthrough and ganttExchange config`

---

### Task 10: Selection logic

**Files:**
- Create: `core-front/packages/core-front/src/views/exchange/selection.ts`, `selection.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ExchangeChange { key: string; kind: string; task: string; wbs?: string; field?: string; before: unknown; after: unknown; default_selected: boolean; requires?: string[]; was_unscheduled?: boolean; dependents?: { subtasks: number; timesheets: number; risk_links: number } }
  export const isRemoval = (c: ExchangeChange) => boolean   // kind ends with '_delete' or === 'delete' or === 'milestone_delete', or (field === 'milestone_id' && after == null)
  export function initialSelection(changes: ExchangeChange[]): Set<string>
  export function toggle(changes: ExchangeChange[], sel: Set<string>, key: string, on: boolean): Set<string> // on: + key + transitive requires; off: − key − everything transitively requiring it
  export function selectAll(changes: ExchangeChange[], sel: Set<string>, on: boolean): Set<string>         // non-removals only; removals keep their state
  export function selectAllRemovals(changes: ExchangeChange[], sel: Set<string>, on: boolean): Set<string>  // removals only (with their requires)
  ```

- [ ] **Step 1: Write failing tests:** the initial selection excludes removals. Ticking a dep on a new task ticks the create. Unticking the create unticks the dep. Ticking a parent delete ticks the child deletes. `selectAll(true)` never adds a removal. `selectAllRemovals(true)` adds every removal. The functions return new Sets (no mutation).
- [ ] **Step 2: Run** `npx pnpm --filter @eerp/core-front vitest run src/views/exchange/selection.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core-front): exchange change selection`

---

### Task 11: Import wizard and Gantt toolbar

**Files:**
- Create: `core-front/packages/core-front/src/views/exchange/import-wizard.tsx`, `import-wizard.test.tsx`
- Modify: `core-front/packages/core-front/src/views/gantt-renderer.tsx` (props, toolbar next to Critical path/Baseline, phone More menu at ~418)
- Modify: `core-front/packages/core-front/src/views/renderers.tsx:1287` (pass `exchange={effective.ganttExchange ?? undefined}`)
- Modify: `core-front/packages/core-front/src/views/gantt-renderer.test.tsx`

**Interfaces:**
- Consumes: Task 9's `GanttExchangeConfig`, Task 10's selection functions, `pinnedId(serverOptions, scopeField)` (already used for baselines), the guard registry used by `canEdit: 'project.canEditStages'` in the OBS renderer (look up how `obs-renderer.tsx` resolves `canEdit`, and resolve `canImport` the same way).
- Produces:
  - `GanttRendererProps.exchange?: GanttExchangeConfig`
  - `export function ImportWizard(props: { open: boolean; onClose: () => void; onApplied: () => void; config: GanttExchangeConfig; scopeId: string; format: ExchangeFormat }): JSX.Element`

Behavior (spec § Frontend):
- **Toolbar.** Shown only while `pinnedId` is set. **Export** is a menu of `formats`, each an `<a href="/api/exchange/<scopeEntity>/<id>/<key>/export" download>`. **Import** is a menu of formats, shown when the `canImport` guard resolves true. On phone, both go in the More menu.
- **Wizard step 1.** A file input with `accept` set and the format label in the title. On pick, POST `preview` (FormData `file`). A 413 shows the text "The file is too large." Other errors show `ErrorAlert`.
- **Step 2:**
  - The warnings sit in a collapsed `Alert` with a count.
  - The rows are grouped by `task`/`wbs`. Each row shows a checkbox, a kind chip, the field, then `before → after`. Dates use the workspace date format helper the engine already uses (find the one the Gantt bar tooltips use). Hours use the number format. "(was unscheduled)" appears when flagged. Removal rows add "has n timesheets, n risk links, n subtasks", leaving out the zero counts.
  - The header holds **Select all** (Task 10's `selectAll`), **Select all removals**, and "n of m selected". An empty list shows "No changes".
  - The **Apply n changes** button POSTs `apply` (FormData `file`, `base`, `keys` appended once per key).
  - The dialog is full screen on phone (`usePhone`).
- **Step 3.** On success, show "n changes applied", then `onApplied()` (the renderer reloads its records, like after a drag). A 409 shows "The project changed since the preview" and a **Preview again** button, which re-runs the preview with the same file. A 422 returns to step 2, highlighting the rows whose key is in `error.fields`, with the message.

- [ ] **Step 1: Write failing tests** (`import-wizard.test.tsx`, `fetch` mocked):
  - The preview renders the rows grouped, and the removals start unticked.
  - Ticking a dep ticks its create.
  - Apply sends exactly the ticked keys.
  - A 409 shows Preview again, which re-POSTs the preview.
  - A 422 highlights the named rows.
  - An empty preview shows "No changes".
  - A 413 shows the size message.

  In `gantt-renderer.test.tsx`: without a pin there are no Export/Import controls. With a pin, Export lists the formats. Import is hidden when the guard is false. On phone the controls sit in the More menu.
- [ ] **Step 2: Run** `npx pnpm --filter @eerp/core-front vitest run src/views/exchange src/views/gantt-renderer.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Run `rtk tsc` and `rtk lint` for the package. Expected: clean.
- [ ] **Step 5: Commit** `feat(core-front): Gantt import wizard and export menu`

---

### Task 12: Project descriptor, i18n, docs

**Files:**
- Modify: `core/modules/project/views/project_views.ts` (next to `ganttBaseline`, ~line 205), `project_views.test.ts`
- Modify: `core/modules/project/i18n/project.pot`, `fr.po`, and the shell/engine catalogs for the engine strings
- Create: `docs/adr/ADR-042-project-plan-exchange.md`
- Modify: `CLAUDE.md` (the `core/modules/project` bullet: the routes, the upload exemption, pitfalls)

- [ ] **Step 1: Write the failing test** in `project_views.test.ts`: the task list descriptor's `viewModeDefaults.ganttExchange` equals `{ scopeField: 'project_id', scopeEntity: 'project', formats: [{ key: 'gan', label: 'GanttProject (.gan)', accept: '.gan' }], canImport: 'project.canEditStages' }`.
- [ ] **Step 2: Run** `npx pnpm --filter @eerp/project vitest run` (or the module package name in its `package.json`). Expected: FAIL.
- [ ] **Step 3: Add the descriptor key.** Add the msgids (Export, Import, Import <format> file, Select all, Select all removals, n of m selected, Apply n changes, No changes, The file is too large., The project changed since the preview, Preview again, the change kind labels, was unscheduled, has … timesheets/risk links/subtasks) with French translations.
- [ ] **Step 4: Write ADR-042.** Cover the context (partner round trip), the decision (server-side neutral `Plan` + `Format`, matching by `eerp_id`, comparing in the file's terms, a single-transaction apply through the shared rules, removals unticked), the consequences (dep types and lags dropped, "before" = current EERP, summary dates ignored), a Mermaid flow (from the spec) and the alternatives (B/C from the spec). Add a CLAUDE.md paragraph in the project bullet, linking ADR-042. Pitfalls to name: a new format = one `Format` + `registerFormat` + one descriptor entry; the upload exemption; the 5000 cap.
- [ ] **Step 5: Run** `make test`. Expected: PASS, all coverage floors met.
- [ ] **Step 6: Run** `graphify update .`
- [ ] **Step 7: Commit** `feat(project): GanttProject exchange on the task Gantt` (docs included)
