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
