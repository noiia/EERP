# Project — Risk analysis workspace

Date: 2026-11-16 · Status: design, awaiting approval

## Why

Project managers keep their risk analysis in a spreadsheet next to the ERP: an AMDEC
(FMEA) register, scored by hand with a legend (likelihood, severity per impact type,
detectability). The ERP already knows most of what the severity depends on: the task
network and its critical path, planned hours, and milestones. Moving the analysis into
the Project app means the scores come from the live plan, not from someone's estimate of
it. Risks also sit next to the tasks they threaten.

The user's reference material is a register spreadsheet with its scoring legend, plus a
per-risk "mind-map" (category / type and description / project phase around the risk).

## Goals

1. A **risk** record per project, holding one AMDEC register row: category, risk (title),
   description, impact on (Delay / Cost / Quality), detectability, likelihood, severity,
   **criticity**, remediation action, residual detectability / likelihood / severity /
   criticity after remediation, responsible person, deadline, project phase.
2. **Automatic severity (option A, chosen by the user)**: a risk is linked to one or more
   tasks with an estimated hit, either **days of delay** or **extra hours**. The server
   computes:
   - **Delay severity**, from the risk's impact on the project's critical path.
   - **Cost severity**, from the extra hours as a % of the project's planned hours.

   `impact_on` picks the scale: a Delay risk counts only the days, a Cost risk only the
   hours. A manual severity overrides the computed one. Quality has no computation, so its
   severity is always typed.
3. **Criticity** = likelihood × severity × detectability (the spreadsheet's example:
   2 × 3 × 1 = 6). The same formula applies to the residual scores.
4. A **Risk** display mode in the task lists' view switcher, next to WBS / PERT / OBS. It
   is available when the list is filtered to one project (the OBS rule). It hosts:
   - **Criticity matrix**: likelihood (rows, 1–3) × severity (columns, 1–4). Each risk is
     a chip in its cell, labelled with its criticity. A toggle switches between the
     before-remediation and residual scores.
   - **Ishikawa (fishbone)**: the head is the project, one bone per risk category, and
     each bone carries its risks, highest criticity first, coloured by criticity.
   - **Register**: a compact read-only table of the AMDEC columns.

   Clicking a risk anywhere in the mode opens its form.
5. A **Risks** menu entry in the Project app: the standard list (the full register with
   search, filters, sort and export, all free from the engine) and the standard form.
6. The **risk form** is the per-risk sheet. Its header is a read-only mind-map of the
   risk: the risk in the centre, linked to its category, its type and short description,
   and its project phase. The mind-map can be exported to PNG/PDF.

## Non-goals

- Editable scoring scales or thresholds (the legend below is fixed in v1).
- A money budget on projects. Cost uses hours.
- Recomputing severities when tasks change elsewhere (see Severity freshness).
- Probabilistic or Monte-Carlo schedule risk.
- Server-side PDF reports (`internal/reports`).
- Risk workflow states (open/closed). Residual scores carry the "after remediation"
  picture.

## Anti-goals

- A severity shown as computed when its inputs were missing (no estimate, project with 0
  planned hours, dependency cycle). It must read as "not computable", never as 1.
- Risks of a members-only project visible to non-members, through any path (list,
  matrix, Ishikawa, distinct, aggregate).
- A second critical-path definition that disagrees with the PERT view's.

## Decided by the user

- Workspace = version 3: risks are their own records with a standard list and form, and
  the task lists get a **Risk** mode holding the Matrix, the Ishikawa and a compact
  register.
- Severity is automated from linked tasks with an estimated hit (option A). A manual
  override exists. Quality stays manual.
- `impact_on` picks the severity scale (Delay = days on the critical path, Cost = extra
  hours, Quality = typed), as in the spreadsheet. It is not just a label.

## Scoring legend (fixed, from the user's spreadsheet)

| Score | Points |
|---|---|
| Likelihood | unlikely 1 · likely 2 · very likely 3 |
| Detectability | easy 1 · difficult 2 · impossible 3 |
| Severity, Delay | critical-path impact: none 1 · < 7 days 2 · 7–14 days 3 · > 14 days 4 |
| Severity, Cost | extra hours / project planned hours: 0 % 1 · < 5 % 2 · 5–10 % 3 · > 10 % 4 |
| Severity, Quality | deliverables hit: none 1 · 1 → 2 · 2 → 3 · > 2 → 4 (typed) |

Criticity ranges from 1 to 36. Colour bands for the matrix, chips and Ishikawa:
≤ 4 green, ≤ 12 amber, > 12 red. *(Builder's call; the bands are a guess.)*

## Data model (`core/modules/project`)

All tables use generic CRUD, like the project's other children.

- **`project_risk`**: `project_id` (set server-side, can't change), `name` (the "Risk"
  column / risk type), `description`, `category_id` → `project_risk_category`,
  `phase_task_id` → `project_task` (a top-level task of the same project, else 422),
  `impact_on` (`delay`|`cost`|`quality`, the register label), `likelihood` (1–3),
  `detectability` (1–3), `severity` (manual override, nullable, 1–4),
  `severity_computed` (read-only, nullable), `severity_effective` and `criticity`
  (stored `GENERATED ALWAYS` columns, like `event_session.remaining_seats`:
  `coalesce(severity, severity_computed)` and its product; null while any factor is
  null), `remediation`, `residual_likelihood` / `residual_detectability` /
  `residual_severity` (nullable), `residual_criticity` (generated), `responsible_id` →
  users (staff), `deadline` (date).
- **`project_risk_task`**: `risk_id`, `task_id` (same project, else 422), `delay_days`
  and `extra_hours` (nullable, ≥ 0; the one matching the risk's `impact_on` is required,
  else 422; a Quality risk's links need no estimate). `project_id` is set from the
  risk. A unique live `(risk_id, task_id)` index makes a duplicate a 409.
- **`project_risk_category`**: `name`, `color` (`#rrggbb`). Shared like
  `project_tag`, with no row scope. `Migrate` seeds *Internal*, *Environment*,
  *Financial* and *Project management* per tenant when absent. Categories are managed
  at `/project/risk_categories` (Configuration menu), like color groups.

**Row scope and rights**: `project_risk` and `project_risk_task` use the same scope as
milestones (they follow the project's visibility; links also hide when their task is deleted). Any project viewer can create and edit
a risk (anyone may raise one). Delete is manager/admin only (403). *(My call, mirroring
tasks vs. project management.)*

## Severity computation (Go, `core/modules/project/risk.go`)

- **Delay**: one forward pass over the project's live tasks and dependencies, with the
  PERT view's conventions (ADR-039 "PERT conventions": `planned_hours`/8 days, else
  `date_start`→`deadline`, else 1 day). The baseline finish is F0. A second pass adds
  each linked task's `delay_days` to its duration and gives F1. The impact is F1 − F0
  calendar days, mapped by the legend. A dependency cycle makes it not computable.
- **Cost**: Σ `extra_hours` / `project.planned_hours`, mapped by the legend. 0 planned
  hours makes it not computable.
- `severity_computed` = the Delay result for a `delay` risk, the Cost result for a `cost`
  risk, always null for `quality`. Changing `impact_on` recomputes it.
- **When it runs** (refined while planning): right after a write to a risk or one of its
  links, and **on every read** of `GET /api/v1/project_risk` (list or `/:id`). A list read
  recomputes the pinned project (`filter[project_id]`), or every project with live risks
  in the tenant when none is pinned. The recompute only `UPDATE`s rows whose
  `severity_computed`/`severity_note` changed. There is no separate recompute endpoint, so
  the Risk mode and the Risks list are never stale. `severity_note` (read-only text)
  stores why a severity can't be computed: `no_estimate`, `cycle` or `no_planned_hours`.
- A shared Go-vs-TS fixture test (the same small network through `computePert` and the
  Go pass, asserting the same finish) guards the anti-goal of two critical-path
  definitions.

**Severity freshness (pitfall, documented)**: a risk's stored computed severity is only as
fresh as the last read or write of risks, so a graph or export of `project_risk` that
doesn't go through the list read can lag.

## Frontend (`core-front`)

- `DisplayMode` gains `risk`. The descriptor key is `risk: { entity: 'project_risk',
  projectField: 'project_id' }`, available only when pinned to one project
  (`availableDisplayModes`, like `obs`). A persisted `risk` mode falls back to List
  otherwise.
- `views/risk/`: `risk-matrix.tsx`, `ishikawa.tsx` (SVG, read-only), `risk-register.tsx`
  and a tab host. They read through the generic list API (`filter[project_id]`) and
  the existing relation label resolution.
- Export: the Matrix and Ishikawa reuse the diagrams' client-side PNG/PDF export.
- Risk form (`project_views.ts`): a mind-map header widget, the register fields, and a
  *Linked tasks* one2many table (`project_risk_task`: task, delay days, extra hours).
  The computed severity is shown read-only next to the override, with a "not computable"
  hint and its reason.
- Light demo seed: a few risks with links on the large WBS/PERT projects.

## Docs

- A new ADR, `docs/adr/ADR-040-risk-analysis.md`, covering the scoring legend, the
  severity computation and freshness, and why the critical path is computed twice.
- Update the Project section of the root `CLAUDE.md` and `core-front/CLAUDE.md`
  (the `risk` mode key).

## Calls made after the builder check (mine, correctable)

- **Task set for the critical path**: all live tasks of the project, with no filter, exactly
  as the PERT view would draw them unfiltered. Closed tasks count in the baseline. A
  delay or extra hours on a **closed** task count as 0, because that work is done.
- **Cost denominator**: `project.planned_hours` as the trigger maintains it. The ADR
  documents what it sums.
- **Task moved to another project or deleted**: the risk's `project_risk_task` rows for
  that task are soft-deleted in the same transaction when it moves (`moveTask`), and a
  `phase_task_id` pointing at it is cleared. A deleted task's links are hidden by the
  link table's scope and ignored by the computation, as timesheets already are, so a
  restored task gets them back.
- **Visibility**: the same as milestones, which follow the project only. A task assignee
  in a members-only project does **not** see its risks. Anyone who sees the project can
  create and edit risks.
- **`project_id` on create**: required, prefilled from the pinned project (the Risk mode,
  or a list filtered to one project), read-only after creation (422 on change).

## Left to the builder

The exact Ishikawa geometry, the matrix chip layout when a cell holds many risks, the
tab order inside the Risk mode, the colour bands, and i18n strings (`.po` entries for
every new label).
