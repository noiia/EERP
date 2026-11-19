# Project — Microsoft Project exchange (MSPDI XML)

Date: 2026-11-18 · Status: design (written on request, without a question round; the
calls made are listed at the end)

Builds on [the GanttProject exchange design](2026-11-18-project-gantt-exchange-design.md)
(the neutral `Plan`, the `Format` interface, the diff/apply pipeline, the import wizard).
Everything there applies here unless stated otherwise.

## Why

Same use case as `.gan`: a **round trip with partners**, here partners who plan in
Microsoft Project. They receive a file, edit it, and send it back. The manager reviews
every change (before → after, one checkbox each) and applies the ones they accept.

## The file format: MSPDI XML, not `.mpp`

`.mpp` is a closed binary format. Nothing reasonable writes it, and reading it needs
MPXJ (a Java library), so a second runtime would have to sit next to `core`.
**MSPDI** (Microsoft Project Data Interchange, `.xml`) is the format Microsoft
documents. MS Project opens and saves it natively ("Save As → XML Format"), and so do
ProjectLibre and most planning tools. EERP exports and imports MSPDI only. A `.mpp`
picked in the import wizard gets a message explaining how to save it as XML. Supporting
`.mpp` (an MPXJ sidecar service) is a non-goal, and can be revisited if partners can't
re-save.

## Which views both tools share

In MS Project, views are lenses over **one** file, so "one exporter per diagram" means
one file carrying the data each shared view needs:

| EERP view | MS Project view | Data carried | In scope |
|---|---|---|---|
| Gantt | Gantt Chart | tasks, outline, dates, % complete, milestones, FS dependencies | yes (as `.gan`) |
| PERT | Network Diagram | dependencies (same data) | yes, and the menu is added to the PERT mode |
| WBS | WBS codes / outline | outline level and order (`OutlineNumber`/`WBS`) ↔ `parent_id`/`wbs_number` | yes, and the menu is added to the WBS mode |
| Calendar | Calendar | task dates (same data) | yes (no extra data) |
| Gantt baselines | Tracking Gantt / Baseline 0–10 | per-baseline start, finish, work per task | **yes, new** |
| Workload page | Resource Usage / Resource Sheet | assignments, resource capacity (`MaxUnits`) | **yes, new** (capacity) |
| Matrices: Eisenhower | Priority field | `priority` ↔ `Priority` | **yes, new** |
| Task form description | Notes | `description` ↔ `Notes` | **yes, new** |
| Insights (EV, burndown) | Earned Value / Burndown reports | planned work, actual work | actual work **exported only** |
| Kanban | Task Board | board status isn't in MSPDI | no |
| OBS, PBS, Risk, RACI, DSM, Portfolio | none | none | no |

The Export/Import menu therefore appears in the **Gantt, PERT and WBS** modes of a
pinned project, for **every** registered format: GanttProject also draws a PERT chart,
so `.gan` benefits as well.

## Goals

1. Export a pinned project as MSPDI XML that MS Project opens with **dates exactly as in
   EERP**.
2. Import a partner-edited MSPDI file through the same wizard, with the same rules
   (matching by EERP id, removals unticked, all-or-nothing apply, 409 on a stale
   preview).
3. Carry the extra data MS Project shares with EERP: priority, notes, baselines,
   resource capacity; actual work is export-only.
4. An exported file opened and saved in MS Project without edits re-imports with **no
   changes**.

## Non-goals

- `.mpp` read or write.
- Dependency types other than FS, lags, constraints, cost, MS Project calendars beyond
  the working weekdays, and splits are not imported (the same warnings as `.gan`).
- Writing timesheets from the file's actual work.
- Overwriting or deleting EERP baselines from a file.

## Design

### Format capabilities (the change to the shared pipeline)

`.gan` doesn't carry priority, notes, baselines or capacity. A diff must never read a
missing field as "cleared". So `Format` gains:

```go
type Field string // "name","dates","planned_hours","closed","milestone_id","priority","description","baselines","capacity"
Carries(f Field) bool
```

`diffPlans` takes the format and skips the fields it doesn't carry. `.gan` declares its
set (the plan-1 fields); MSPDI declares all of them.

### Neutral plan additions

- `PlanTask` gains `Priority bool`, `Notes string` and `ActualHours float64` (export
  only).
- `Plan` gains `Baselines []PlanBaseline{Number int; Tasks map[key]{Start, Duration,
  Work}}` and `Resources []PlanResource{Email, Name string; HoursPerWeek float64}`.

### MSPDI mapping

| EERP | MSPDI | Notes |
|---|---|---|
| task id | an extended attribute "EERP id" (`FieldID` of Text30, alias `EERP id`); the task `GUID` is also set to the id | match by the extended attribute only (MS Project keeps both; a copy-paste gets a new GUID but keeps Text30, which is the duplicate case) |
| hierarchy and order | `OutlineLevel` + document order (`OutlineNumber`/`WBS` written, ignored on read) | same move rules as `.gan` |
| `date_start` / `deadline` | `Start` / `Finish` (08:00 / 17:00), `Duration` = workdays × 8h, **`Manual` = 1** | manually scheduled, so MS Project doesn't reschedule on open |
| `planned_hours` | `Work` (`PT16H0M0S`) | |
| `spent_hours` | `ActualWork` | export only |
| closed | `PercentComplete` 100 / 0 | same rule as `.gan`; summary tasks ignored |
| `priority` | `Priority` 1000 / 500 | import: > 500 → true |
| `description` | `Notes` | plain text, ≤ the description limit |
| milestone | `Milestone` = 1, duration 0 | task → milestone link as an FS predecessor, as in `.gan` |
| dependency | `PredecessorLink` `Type` 1 = FS (0 FF, 2 SF, 3 SS), `LinkLag` | |
| assignee | `Resource` (`EmailAddress`, `Name`) + `Assignment` | |
| capacity | `Resource.MaxUnits` = hours_per_week / 40 | |
| baselines | the newest 11 live EERP baselines → `Baseline` `Number` 0..10 (0 = newest) on each task (`Start`, `Finish`, `Work`) | |
| working weekdays | the project calendar's `WeekDays` | exceptions → `HOLIDAYS` warning |

### Import rules for the new data

- **Priority, description**: normal update rows (ticked).
- **Baselines**: EERP baselines are frozen snapshots and are never edited. A file
  baseline number whose data differs from what the export wrote for that number (or
  that didn't exist) becomes **one `baseline_create` row**: "Create baseline 'Baseline
  n (imported <date>)' with m tasks", ticked. Its task rows come from the file; tasks
  that are new in the same import `require` their create. The limit of 20 live
  baselines → 422 on that key.
- **Capacity**: a resource whose `MaxUnits` differs → a `capacity_update` row, **unticked**
  and labelled *workspace-wide* (capacities apply across all projects). Applying it
  needs the caller's `project_capacity:project_capacity:write` permission (else 422 on
  the key). An unknown email → `UNKNOWN_EMAIL`, as for assignees.
- **Actual work**: ignored on import, with no row and no warning.

### Frontend

- The descriptor's `ganttExchange.formats` gains
  `{ key: 'mspdi', label: 'Microsoft Project (.xml)', accept: '.xml' }`.
- The plan-1 toolbar code is extracted into an `ExchangeMenu` component, used by the
  Gantt toolbar and passed as `toolbarExtra` to the WBS and PERT diagram canvases
  (pinned project only; it sits in the More menu on phone, the canvas' existing
  pattern).
- The wizard renders the new kinds: `baseline_create` (name, task count), and
  `capacity_update` (user, `h/week` before → after, a *workspace-wide* chip). A long
  description shows truncated before/after, with "Show all".
- Picking a `.mpp` shows "MS Project's .mpp format can't be read. In MS Project, use
  File → Save As → XML Format, then pick that file." without uploading.

### Testing

The plan-1 suite, repeated for MSPDI: codec fixtures, malformed XML, the 5000 cap,
export → import is empty (including baselines, priority, notes and capacity), and an
"opened and saved in MS Project" fixture. That fixture needs MS Project; ProjectLibre is
a fallback, but MS Project is the target to verify. Plus `Carries`: a `.gan` import
never produces priority, description, baseline or capacity rows.

### Docs

ADR-042 gets an "MS Project" section: why MSPDI rather than `.mpp`, the capability set,
manual scheduling, and baselines being append-only. The `CLAUDE.md` project bullet gets
the same in a few lines.

## Calls made without the user (check these)

1. MSPDI XML only. `.mpp` gets a "save as XML" message.
2. The menu appears in the Gantt, PERT and WBS modes, for both formats.
3. Tasks are exported **manually scheduled**, so MS Project keeps EERP's dates.
4. Baselines: export the newest 11. An import only ever **creates** baselines, ticked.
5. Capacity changes are offered **unticked**, flagged *workspace-wide*, and need the
   capacity write permission.
6. Actual work is exported, never imported.
7. Match by the "EERP id" extended attribute (Text30), with the GUID set as well.
