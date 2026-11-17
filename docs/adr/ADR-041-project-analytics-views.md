# ADR-041: Project analytics & planning views

Status: accepted · 2026-11-17 · Epic: noiia/EERP#41

## Context

The Project app stores the plan (tasks, dates, planned hours) and the actuals
(timesheets) but never puts them side by side: a manager can see a task's spent
hours, but not the project's earned value, its burndown, where the critical path
runs, who is over capacity, or how the risks' criticity has moved. Those answers
today live in spreadsheets rebuilt by hand next to the ERP.

The epic adds, on top of the existing task lists and the Risk mode, an
**Insights** mode (earned value, burndown, schedule variance, capacity,
workload, portfolio) and a **Matrices** mode (Eisenhower, RACI, design-structure
matrix), plus a PBS deliverables view and the schedule baselines to compare
against. Every new figure is derived from the rows the app already owns; no
new capture, so the existing triggers and write rules keep the source data
consistent.

## Decision

### closed_at, stage history and risk history (WP1)

The analytics views need two facts the app never stored: when a task actually
closed, and how its scores and positions moved over time. Rather than recompute
them from snapshots or infer them from `updated_at`, the truth is written once,
by the same Postgres triggers that already own the aggregates (`migrate.go`):

- **`project_task.closed_at`** (TIMESTAMPTZ, read-only on the API): the moment
  the task moved into a closed stage; moving back to an open stage clears it.
  Kept by the very trigger that mirrors `closed` from the stage, so the two can
  never disagree. `Migrate` backfills it for tasks already closed (their last
  `updated_at`), idempotently.
- **`project_task_stage`** (append-only interval rows: `task_id`, `project_id`,
  `stage_id`, `entered_at`, `left_at`): an AFTER trigger on
  `stage_id, project_id, deleted_at` closes the task's open row and opens a new
  one on a stage or project change, closes it on soft delete, reopens it on a
  restore. A live task that has a stage has exactly one open row (`left_at`
  NULL); `Migrate` backfills one per such task with `entered_at = created_at`.
  A task without a stage has no span: `stage_id` is NOT NULL by design.
- **`project_risk_history`** (one row per risk per day: `recorded_on` DATE,
  `criticity`, `residual_criticity`, `deleted`): an AFTER trigger on
  `project_risk` upserts the day's row (`ON CONFLICT (risk_id, recorded_on)`)
  whenever `criticity`, `residual_criticity` or `deleted_at` changes, and marks
  today's row `deleted` when the risk is soft-deleted. An INSERT trigger's WHEN
  may not reference OLD, so the "distinct from the old value" guard lives in
  the function body; an unscored risk (all three NULL) records nothing.

Both history tables are registered `orm.WithExcluded()`; the schema is
migrated like every registered table, but they never reach the HTTP surface:
their only writer is the trigger, and later views (WP2) read them straight from
the database. `closed_at` is a read-only field of the task like `closed` and
the hour totals (a read-only `datetime` column on the task list and form).

## Pitfalls

- Never write `closed_at` or the history tables by hand (Go handler or
  frontend): they are trigger-owned, like `task_count` and `spent_hours`. A
  direct write is silently corrected on the next stage move, or never.
- A task with `stage_id NULL` has no `project_task_stage` rows, open or
  closed: the backfill and the trigger both skip it on purpose (`stage_id` is
  NOT NULL on the span rows).
- `closed_at` is set by the trigger's `now()`, not by `updated_at`: the two can
  differ by the write's transaction time, and a backfilled `closed_at` is an
  estimate (the task's last `updated_at` before the migration), never the real
  close time.
- `project_risk_history` keeps one row per (risk, day): the day's value is the
  LAST one, and a day on which only an unscored risk was edited adds no row.
  Nothing is ever deleted from it; a soft-deleted risk's rows stay, marked
  `deleted`.
- The backfills and the `recorded_on` type narrowing (TIMESTAMPTZ → DATE) run
  inside the module's `Migrate`, after `ensureSchema` created the tables: they
  are idempotent, but the module must register the two tables for their DDL to
  exist in the first place.

### Project metrics endpoint (WP2)

`GET /api/v1/project/:id/metrics` answers one question per point in time:
what was the project's scope and done work, its earned value and actual cost,
where the tasks were (per stage), and how the risks looked — all as exact
time series. That is why it is a server-side endpoint and not a client
aggregation over the generic API: the window is a `generate_series` walked in
SQL (one query per series, tenant-pinned), so the figures are exact for any
date, and the row-scope gate (`orm.CanSeeRecord`) happens at a single point —
a non-member or a mere task assignee gets a 404, never a series or task ids.
The cross-project pages (portfolio, workload) keep using the generic API: no
new permissions, row scope for free.

The window runs from the project's `date_start` (else the earliest live
task's `created_at`, else today) to `max(today, date_end)`, capped at
`from + 3 years`. The bucket is `day` when the span is ≤ 120 days, else
`week` with points on Mondays; the last point is always today when today is
in the window (the daily grid walks the full window, which may end in the
future; the weekly grid trims at today). The series are:

- **Burndown:** scope(t) = Σ planned_hours (and the count) of the tasks
  created by t and not yet deleted, with time-varying project membership from
  the `project_task_stage` intervals (they carry `project_id`, so a moved
  task counts in the old project only up to the move date). done(t) is the
  same restricted to `closed_at <= t`; remaining = scope − done.
- **Earned value:** PV(t) = Σ planned_hours × clamp((t − date_start) /
  (deadline − date_start), 0, 1) over the live tasks with both dates (a task
  where `deadline <= date_start` counts fully from its deadline); EV(t) = Σ
  planned_hours of the tasks with `closed_at <= t`; AC(t) = Σ live timesheet
  hours with `date <= t`. SPI = EV/PV and CPI = EV/AC at today, `null` when
  the denominator is 0.
- **Ideal line:** from scope(from) at `from` down to 0 at `date_end`
  (none when `date_end` is NULL or before `from`), on the bucket's grid
  clipped at the window's `to`.
- **Flow:** the live tasks' stage per date, from the same intervals.
- **Risk trend:** each risk's LAST `project_risk_history` snapshot at or
  before the date (a deleted snapshot drops the risk out), banded per
  ADR-040 (criticity ≤ 4 green, ≤ 12 amber, > 12 red).

`pv_excluded` counts the live tasks without both dates: PV skips them,
nothing else does.

Pitfalls:

- The history starts at the migration time: spans backfilled for
  pre-existing tasks have `entered_at = created_at` (an estimate), and
  `project_risk_history` has no rows before it — the charts are exact from
  the migration on, approximate before.
- The endpoint reads the excluded history tables straight from the database:
  those typed reads bypass the generic row scope, which is why the visibility
  gate runs first and every query is tenant-pinned (the tables are
  `orm.WithExcluded()`, so no route of the generic CRUD can serve them).
- EV equals done_hours by construction (both are the closed tasks' planned
  hours); the duplicate field exists so the burndown and the EVM views read
  their own names.
- AC uses the timesheets' current `project_id`: hours follow the task to its
  new project when it moves.
- A project with no dates, no hours and no timesheets answers one point of
  zeros with SPI/CPI `null` and `pv_excluded` set — never a division by zero.
- The client-side reads of the Insights mode page until a short page and stop
  at 1000 records with a "first 1000 shown" caption (ADR-032); the endpoint
  itself is bounded by the 3-year window and the bucket.

### Gantt critical path and baselines (WP6)

The Gantt mode already draws the plan; WP3's schedule and baseline endpoints
hold the "what is critical / what was planned" facts. Both are rendered as
overlays on the existing renderer (`views/gantt-renderer.tsx`), gated on the
search bar's single-value pin (`pinnedId` on `project_id`) — with no pin there
is no project to compute them for, and the controls stay hidden:

- **Critical path** (a toolbar `Critical path` button; on phone the More
  menu): with the toggle on the renderer reads the schedule once —
  `ops.get('project', '<id>/schedule')`, once per pinned id and toggle state,
  so a bar move never refetches it — and outlines the critical tasks with a
  2px `error.main` outline (a non-color cue besides the color one). Every
  bar present in the schedule reports its slack in its `aria-label`
  (`, slack N d`). A `cycle: true` answer draws no outline and says
  "Dependency cycle: no critical path" instead. The toggle state is kept per
  entity for the tab session (`eerp.gantt.critical.<entity>`), the zoom's
  pattern.
- **Baselines** (a toolbar `Baseline` select; on phone the same More menu):
  the select lists the project's `project_baseline` rows newest first
  (`order=-created_at`; the server caps them at 20, so one page suffices) and
  a pick reads that baseline's `project_baseline_task` rows in chunks of 100
  `in[task_id]` limited to the visible rows' ids (the dependency-links
  pattern). Each task the snapshot holds gets a 6px `action.disabled` ghost
  bar under its live bar, clipped to the visible range like the bar itself;
  rows the snapshot lacks get none.
- **Save baseline** (a `Save baseline` header button on the project form):
  prompts for a name, then `runAction('baseline', { body: { name } })`
  (WP3's `POST /project/:id/baseline`). The manager/admin gate is Go's
  `can_manage`, an async server check, while a header button's
  `states.visible` is the field-only condition DSL (it cannot await) — so the
  `project.canEditStages` kanban guard runs inside the handler, before the
  prompt.

### Matrices mode: Eisenhower, RACI and dependency matrix (WP8)

The Matrices mode (`views/matrix/`) gives the pinned project's task list a
third analytics angle: where the Risk mode reads `project_risk` rows and the
Gantt the schedule, it reads the task rows themselves, once for all three
tabs (`filter[project_id]`, pages of 200, capped at 1000 with a visible
"first 1000 shown" caption per ADR-032). `MatrixConfig` therefore carries the
task entity and the task form route (`taskEntity` / `taskFormPath`,
module-declared like every other mode config), so the renderer is
self-contained the way `RiskRenderer` and `ObsRenderer` are. Each tab fetches
its own extras on top of the shared task set:

- **Eisenhower** (`eisenhower.tsx`): the four quadrants of the Global
  Constraints — Do (important and urgent), Schedule (important), Delegate
  (urgent), Eliminate (neither) — where important is the task's `priority`
  boolean and urgent is a deadline strictly inside the config's `urgentDays`
  horizon (overdue counts). Closed tasks never appear. A card's `Toggle
  priority` button (write permission only) flips the field through
  `useOptimisticFieldMove`, so the card moves across quadrants instantly and
  reverts, with an error alert, on a rejected PATCH. On phone the quadrants
  stack as four collapsible sections with their counts.
- **RACI** (`raci.tsx`): rows are the tasks in `wbs_number` order, columns
  are the project's manager plus its `project_member` rows (plus anyone
  already holding a role). A cell is one `project_task_raci` row (task x user
  x role); with write permission tapping it cycles
  `– -> R -> A -> C -> I -> –` (create / update / delete through
  `useOptimisticFieldMove`), and a 422 `ONE_ACCOUNTABLE` rejection — Go
  enforces at most one accountable per task — surfaces the server's message
  and reverts the cell. A row without an `A` is flagged "No one
  accountable". The task form hosts the same rows as a `raci` one2many page.
  Read-only users see the letters only. On phone the grid becomes a per-task
  card listing `R / A / C / I` and an `Edit` dialog with one select per
  person.
- **Dependency structure matrix** (`dsm.tsx`): rows and columns are the
  tasks in `wbs_number` order (the WBS diagram's `compareOrder`, dotted
  numbers compared segment by segment), and a dependency "A depends on B"
  fills the cell at row A (the dependent), column B (the blocker) — the
  dependency rows are read in chunks of 100 `in[task_id]` over the visible
  ids, the Gantt links' pattern. The diagonal is greyed, hovering a cell
  highlights its row and column, and tapping a mark opens the dependent
  task's form. Over 150 tasks the grid caps at 150 and says so; on phone it
  scrolls inside its own box with sticky row and column headers.

## PBS deliverables (WP11)

A project's **PBS** (project breakdown structure) is a free tree of
deliverables its tasks produce. It is stored like the OBS boxes, with two
differences that shape the rest of this section:

- **`project_pbs_item`** (`project_id`, `parent_id`, `name` ≤ 200 chars,
  `description` ≤ 2000 chars, `color` `#rrggbb` lowercase or NULL, `x`, `y`)
  is manager-writable (same rules as the OBS boxes) and tenant- and
  project-scoped like its siblings.
- A task links to the deliverable it produces through
  **`project_task.pbs_item_id`** (NULL by default, indexed): any task editor
  may set or clear it, not only the manager. The link is a task field, not a
  join table, so it moves with the task and dies with it.

The item carries **`task_count`** and **`done_count`**, both read-only and
trigger-maintained, like `milestone.task_count`: an AFTER trigger on
`project_task` recounts the old and the new item whenever a link, a close or a
soft delete/restore changes. The trigger fires on every row change, not on
`UPDATE OF pbs_item_id, closed, deleted_at`: the `closed` mirror flips on a
stage move the statement never lists, and Postgres counts only the statement's
own SET columns for `UPDATE OF`, so such a trigger definition would keep
`done_count` stale. The function bails out when none of the three columns
changed, so an unrelated edit costs two counted no-ops.

Deleting an item (manager only) detaches in one transaction: its live children
lose their parent, its live tasks lose the link, then the item is soft-deleted
(the counts fall back to zero on the way). Moving a task to another project
clears the link, like the milestone. Deleting and restoring a project carries
the items with it: they are in the project's delete/restore table lists, under
the same `deleted_at`.

### Workload heatmap and capacities (WP10)

The Planning menu's **Workload** page (`/project/workload`, a hidden
`project_task` dashboard route) shows planned hours per assignee x week over
the coming 8-week window (4 weeks on a phone: the user column stays sticky,
the weeks scroll horizontally inside their own box). It reads the open tasks
with `planned_hours > 0` overlapping the window (the list query
`filter[closed]=false`, `gte[deadline]=<window start>`, `lt[date_start]=<window
end>`, `gt[planned_hours]=0`), spreads each task's planned hours evenly over
the Mon-Fri workdays of its `[date_start, deadline]` span (a weekend-only span
moves its whole load to the following Monday; workdays outside the window are
dropped), and splits the share equally among the task's assignees. Tasks
without an assignee land in an **Unassigned** row. Each cell is colored against
the user's `project_capacity.hours_per_week` (default 40 h/week when the user
has no row): uncolored up to 80%, warning up to 100%, error above. A cell click
opens the task list with `filter[assignees]=<user>`; a Project filter narrows
the task read to one project. Like the other planning pages, the read is
capped at 1000 rows with the "First 1000 shown" caption.

**Capacities** (`/project/capacities`, a hidden `project_capacity` tree route
reached from one Configuration-menu line) edit the `project_capacity` rows
(user, `hours_per_week` in 1..168 by a DB check, one live row per user by the
tenant-unique index). The table existed since WP4; WP10 gives it a surface -
the heatmap reads it, and the light seed adds a 24 h/week row for the
signed-in user.

### Portfolio dashboard (WP10)

The Planning menu's **Portfolio** page (`/project/portfolio`, a hidden
`project` dashboard route) plots the visible active projects (`?filter[active]=true`,
read capped at 1000 with the "First 1000 shown" caption) as one plain-SVG
bubble each: x = % tasks done, y = % planned hours used (spent/planned,
capped at 200%; a project with no planned hours sits hollow on the bottom
axis), size = planned hours, color = the project's worst risk criticity band
from the graph-widgets categorical palette (red, amber, green, or grey when
it has no risks). The figures come from the named server aggregates
(`?aggregate=count&group=project_id`): the project's closed tasks, and its
`project_risk` counts in the criticity bands > 12 (red), 4..12 (amber) and
<= 4 (green - the third band is what separates "green risks" from "no risks"
in the color). The table beside the chart shows the manager (by email),
progress, hours (spent / planned, or "-" when unplanned), the end date, a
**Late** flag (past `date_end` before 100% done) and the risk dot (a
titled mark, never color alone). A row or a bubble click opens the
project's tasks (`filter[project_id]`); on a phone the chart becomes a
square full-width block and the table becomes one card per project.
