# Project Risk Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add risks (an AMDEC register) to the Project app. Severity is computed from linked tasks. A **Risk** display mode (criticity matrix, Ishikawa, compact register) appears in the task lists, and the risk form carries a mind-map header.

**Architecture:**
- Three new generic-CRUD tables in `core/modules/project`, guarded and row-scoped like the project's other children.
- A Go forward pass (the PERT view's conventions) computes severity on every risk read and write. Criticity is a stored generated column.
- The frontend adds one display mode, `risk`, offered while the list is pinned to one project (the OBS rule). Its renderer has three tabs.
- One new engine field widget, `text/mindmap`, draws the form header.

**Tech Stack:** Go (Echo, core/orm, pgx, Postgres 18), Next.js + React 19 + MUI, vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-project-risk-analysis-design.md`

## Global Constraints

- Likelihood 1–3, detectability 1–3, severity 1–4 (manual and residual). Out of range → 422 from the guard, plus a CHECK constraint.
- Delay severity from critical-path impact in days `d`: `d < 1e-6` → 1, `d < 7` → 2, `d <= 14` → 3, else 4.
- Cost severity from `pct = Σ extra_hours / project.planned_hours × 100`: `pct < 1e-6` → 1, `pct < 5` → 2, `pct <= 10` → 3, else 4.
- `impact_on` ∈ `delay|cost|quality` and picks the scale. `quality` → `severity_computed` is always NULL.
- `criticity = likelihood × coalesce(severity, severity_computed) × detectability`, NULL when any factor is NULL. Same formula for the residual scores (no computed part).
- Colour bands: criticity ≤ 4 green, ≤ 12 amber, > 12 red.
- PERT conventions (ADR-039): duration = `planned_hours/8` days if > 0, else `deadline − date_start` days if > 0, else 1. Finish = longest path. A cycle makes the severity not computable.
- A delay or extra hours on a **closed** task counts as 0.
- `severity_note` ∈ `no_estimate|cycle|no_planned_hours|NULL`.
- Seeded categories (per tenant, when absent): `Internal`, `Environment`, `Financial`, `Project management`.
- Commits: `<type>(scope): …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use `rtk` before commands. Search with `rg`, never `grep`.
- Never lower coverage thresholds. `make test` must pass before a push.

## Review Focus

1. A project with no estimated task, or 0 planned hours → `severity_computed` NULL with a note, and `criticity` NULL. Never a severity of 1 shown as computed. *(Task 2 and Task 4 tests.)*
2. A dependency cycle in the project → note `cycle`, no 500. *(Task 2 and Task 4.)*
3. Changing `impact_on` from `delay` to `cost` while the links carry only `delay_days` → the risk PUT succeeds and the note reads `no_estimate`. Only link writes enforce the matching estimate. *(Task 4.)*
4. A non-member reading `project_risk` of a members-only project through list, `/:id`, `?distinct=` and `?aggregate=` gets nothing (404 / empty), and the read-triggered recompute doesn't leak anything either. *(Task 3.)*
5. A risk whose phase or linked task moves to another project → its links are gone and its phase is cleared, and the severity is recomputed on the next read. *(Task 4.)*

---

### Task 1: Tables, generated columns, category seed

**Files:**
- Modify: `core/modules/project/models.go` (append 3 structs)
- Modify: `core/modules/project/module.go` (register them)
- Modify: `core/modules/project/scope.go` (add `RiskLinkScope`)
- Modify: `core/modules/project/migrate.go` (DDL, CHECKs, index, seed)
- Modify: `core/modules/project/scope_test.go` (`projectTables` list: add `project_risk_task`, `project_risk`, `project_risk_category` before `project_task`)
- Test: `core/modules/project/risk_test.go` (new)

**Interfaces:**
- Produces: tables `project_risk`, `project_risk_task`, `project_risk_category`; Go types `ProjectRisk`, `ProjectRiskTask`, `ProjectRiskCategory`; `RiskLinkScope(perms) orm.RowScopeFunc`.

- [ ] **Step 1: Write the failing test** `TestRisk_Schema` in `risk_test.go`, using `newFixture`:
  - insert a project and a risk with `likelihood=2, detectability=1, severity=3, impact_on='quality'` by SQL; assert `criticity = 6` and `severity_effective = 3`
  - set `severity = NULL` → `criticity IS NULL`
  - an insert with `likelihood = 4` fails (CHECK)
  - two live `project_risk_task` rows with the same `(risk_id, task_id)` fail (unique)
  - after `Migrate`, `SELECT count(*) FROM project_risk_category WHERE tenant_id = <a seeded company's tenant>` ≥ 4, and running `Migrate` again doesn't duplicate them

- [ ] **Step 2: Run** `rtk go test ./modules/project/ -run TestRisk_Schema` (from `core/`). Expected: FAIL, the table doesn't exist.

- [ ] **Step 3: Implement.** Struct fields, `db`/`json` tags as named:
  - **`ProjectRisk`**: `BaseModel`, `TenantID`, `ProjectID uuid.UUID` (`project_id,index`), `Name string`, `Description *string`, `CategoryID *uuid.UUID`, `PhaseTaskID *uuid.UUID`, `ImpactOn string`, `Likelihood *int`, `Detectability *int`, `Severity *int`, `SeverityComputed *int`, `SeverityNote *string`, `SeverityEffective *int` (`severity_effective,generated`), `Criticity *int` (`criticity,generated`), `Remediation *string`, `ResidualLikelihood`/`ResidualDetectability`/`ResidualSeverity *int`, `ResidualCriticity *int` (`,generated`), `ResponsibleID *uuid.UUID`, `Deadline *time.Time`.
  - **`ProjectRiskTask`**: `TenantID`, `ProjectID`, `RiskID`, `TaskID` (indexed), `DelayDays *float64`, `ExtraHours *float64`.
  - **`ProjectRiskCategory`**: `TenantID`, `Name string`, `Color *string`.

  Registration:
  - `project_risk`: `ChildScope`, read-only `severity_computed`, `severity_note`.
  - `project_risk_task`: `RiskLinkScope` = `scope(perms, childSQL + " AND task_id IN (SELECT t.id FROM project_task t WHERE t.deleted_at IS NULL AND t.tenant_id = $2)")`.
  - `project_risk_category`: no scope.

  Migrations, following `event/module.go:62`:
  - The generated columns use `ADD COLUMN IF NOT EXISTS … GENERATED ALWAYS AS (…) STORED`. `criticity` must inline `COALESCE(severity, severity_computed)`, because Postgres refuses a generated column that references another generated column.
  - `check(...)` for each score range and for `impact_on IN ('delay','cost','quality')`.
  - The unique live index `idx_project_risk_task_live`.
  - The category seed: `INSERT … SELECT DISTINCT c.tenant_id, name FROM company c CROSS JOIN (VALUES …) WHERE NOT EXISTS (…)`.

- [ ] **Step 4: Run** the same test. Expected: PASS. Also `rtk go test ./modules/project/` stays green.

- [ ] **Step 5: Commit** `feat(project): risk tables with generated criticity`

### Task 2: Severity engine (pure Go) + shared PERT fixture

**Files:**
- Create: `core/modules/project/risk_calc.go`
- Create: `core/modules/project/testdata/risk_pert_fixture.json`
- Test: `core/modules/project/risk_calc_test.go`
- Test: `core-front/packages/core-front/src/views/diagram/pert.test.ts` (add one case)

**Interfaces:**
- Produces:
  ```go
  type calcTask struct { ID uuid.UUID; PlannedHours float64; DateStart, Deadline *time.Time; Closed bool }
  type calcLink struct { From, To uuid.UUID } // From blocks To
  func taskDays(t calcTask) float64
  func projectFinish(tasks []calcTask, links []calcLink, extra map[uuid.UUID]float64) (float64, bool) // false = cycle
  func delaySeverity(days float64) int
  func costSeverity(pct float64) int
  // riskSeverity applies impact_on; note is "" when computable.
  func riskSeverity(impactOn string, tasks []calcTask, links []calcLink, plannedHours float64, risk []ProjectRiskTask) (sev *int, note string)
  ```
- The fixture JSON is `{ "tasks": [{id, plannedHours, dateStart, deadline}], "links": [{from,to}], "finish": <days> }`, with 6 tasks, two parallel chains and one undated, unestimated task.

- [ ] **Step 1: Write failing tests**, table-driven `t.Run`:
  - `TestDelaySeverity`: 0→1, 6.9→2, 7→3, 14→3, 14.1→4
  - `TestCostSeverity`: 0→1, 4.9→2, 5→3, 10→3, 10.1→4
  - `TestProjectFinish_Fixture`: loading the fixture gives a finish equal to `fixture.finish`
  - `TestRiskSeverity`:
    - a delay of 8 days on a critical task → 3
    - 8 days on a task with ≥ 8 days of slack → 1
    - a delay on a closed task → 1
    - a cycle → nil, `"cycle"`
    - `cost` with plannedHours 0 → nil, `"no_planned_hours"`
    - `delay` with no `delay_days` on any link → nil, `"no_estimate"`
    - `quality` → nil, `""`

  In `pert.test.ts`, add `it('matches the shared Go fixture')`: import the JSON by relative path and assert `computePert(tasks, links).finish` is close to `finish`, to 1e-6.

- [ ] **Step 2: Run** `rtk go test ./modules/project/ -run 'Severity|Finish'` and `rtk vitest run src/views/diagram/pert.test.ts` (in `core-front/packages/core-front`). Expected: Go FAILS (undefined). TS should already PASS: that pins the fixture's `finish` to the TS engine.

- [ ] **Step 3: Implement** `risk_calc.go`. `projectFinish` uses Kahn ordering plus an ES/EF forward pass that adds `extra[id]` to the duration. `riskSeverity` computes the baseline F0 with `extra = nil` and F1 with each non-closed linked task's `delay_days` summed per task. Cost sums `extra_hours` over the non-closed linked tasks.

- [ ] **Step 4: Run** both commands. Expected: PASS.

- [ ] **Step 5: Commit** `feat(project): risk severity engine sharing PERT's fixture`

### Task 3: Write guards, rights and visibility

**Files:**
- Modify: `core/modules/project/validate.go` (`riskRules`, `riskLinkRules`, `riskCategoryRules`, three `Validate…Body`)
- Modify: `core/modules/project/handler.go:45-58` (add the 3 guards to `Mount`)
- Test: `core/modules/project/risk_test.go`

**Interfaces:**
- Consumes: Task 1's tables, plus the `request` helpers `fixedProject`, `visibleRef`, `inProject`, `requireManage`, `taskLinkRules`.
- Produces: `(h *Handler) ValidateRiskBody`, `ValidateRiskLinkBody` and `ValidateRiskCategoryBody`, all `echo.MiddlewareFunc`.

- [ ] **Step 1: Write failing tests**:
  - **`TestRiskRules`**, a `[]writeCase` through `f.run`:
    - create without `project_id` → 422
    - `project_id` change → 422
    - likelihood 0 / 4 → 422
    - severity 5 → 422
    - `impact_on: "time"` → 422
    - `phase_task_id` = a subtask, or a task of another project → 422
    - `category_id` of the sibling tenant → 422
    - `responsible_id` = a website user → 422
    - a non-manager viewer creates → 201
    - a non-manager deletes → 403
    - the manager deletes → 200
  - **`TestRiskLinkRules`**:
    - a task of another project → 422
    - on a `delay` risk, a link without `delay_days` → 422
    - on a `cost` risk, a link without `extra_hours` → 422
    - a negative value → 422
    - on a `quality` risk, a bare link → 201
    - a duplicate → 409
    - the body's `project_id` is ignored, and the stored one equals the risk's project
  - **`TestRiskCategoryRules`**: empty name → 422; color `#ABC` → 422; `#AABBCC` is stored as `#aabbcc`.
  - **`TestRiskScope_MembersOnly`**: with a non-member caller on a members-only project:
    - `f.get(project_risk/<id>)` → 404
    - `f.total(project_risk?filter[project_id]=<p>)` = 0
    - `?distinct=impact_on` returns no values
    - `?aggregate=count&value=criticity` returns no groups
    - `project_risk_task` list total = 0
    - an assignee of a linked task still gets 404 on the risk

- [ ] **Step 2: Run** `rtk go test ./modules/project/ -run 'Risk(Rules|LinkRules|CategoryRules|Scope)'`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`riskRules`**: `fixedProject`; `visibleRef("project", "project_id", true)`; range checks; `inProject("project_task", "phase_task_id", pid)` plus a check that its `parent_id IS NULL`; a staff-user check on `responsible_id` (reuse obsRules' staff query); `requireManage(pid)` only when `r.op == opDelete`; default `impact_on` to `delay` on create.
  - **`riskLinkRules`**: on top of `taskLinkRules`, the `risk_id` must be visible and in the same project. Read its `impact_on` and require the matching estimate, ≥ 0.
  - **`riskCategoryRules`**: reuse `colorRules`' color normalisation.

- [ ] **Step 4: Run** the tests. Expected: PASS.

- [ ] **Step 5: Commit** `feat(project): risk write rules and visibility`

### Task 4: Recompute on read and write; task move

**Files:**
- Create: `core/modules/project/risk.go`
- Modify: `core/modules/project/handler.go` (Mount: wrap `project_risk`/`project_risk_task` Create/Update/Delete/Restore, wrap `GET /api/v1/project_risk` and `/:id`; `moveTask`: risk links and phases)
- Test: `core/modules/project/risk_test.go`

**Interfaces:**
- Consumes: `riskSeverity` and friends from Task 2.
- Produces:
  ```go
  // recomputeRisks rewrites severity_computed/severity_note of the live risks of
  // the given projects (all tenant projects with live risks when projects is empty),
  // only where a value changed.
  func recomputeRisks(ctx context.Context, ex orm.Executor, tenant uuid.UUID, projects ...uuid.UUID) error
  func (h *Handler) RecomputeOnRead(next echo.HandlerFunc) echo.HandlerFunc
  func (h *Handler) RecomputeAfterWrite(table string, next echo.HandlerFunc) echo.HandlerFunc
  ```

- [ ] **Step 1: Write failing tests**:
  - **`TestRiskRecompute_DelayChain`**: tasks A→B→C at 16 h each, and D standalone at 8 h. A delay risk links B with 8 days. `GET project_risk/<id>` returns `severity_computed` 3 and `criticity` = L×3×D. Then add a dependency D→A and re-GET: unchanged. Then set B's `planned_hours` to 200 by SQL: still 3, because the impact stays 8 days.
  - **`TestRiskRecompute_Cost`**: project planned 100 h, a cost link with 7 h → `severity_computed` 3. With project planned 0 h → NULL and `severity_note` `no_planned_hours`.
  - **`TestRiskRecompute_ImpactChange`**: a delay risk with a days-only link. PUT `{impact_on: "cost"}` → 200, and the body shows `severity_note` `no_estimate`, `criticity` null.
  - **`TestRiskRecompute_Cycle`**: A→B→A → note `cycle`, status 200.
  - **`TestRiskRecompute_ManualOverride`**: `severity: 1` beats a computed 3, so criticity uses 1.
  - **`TestRiskRecompute_UnpinnedList`**: `GET project_risk` (no filter) as admin recomputes risks in two projects.
  - **`TestUpdateTask_MoveDropsRiskLinks`**:
    - move a top-level task (the risk's phase, with a linked subtask) to another project
    - the link rows are soft-deleted and `phase_task_id` IS NULL
    - the next GET shows `no_estimate`
  - **`TestRiskLinks_DeletedTaskHidden`**: soft-delete a linked task → the link list total is 0 and the severity is recomputed without it. Restore the task → the link is back.

- [ ] **Step 2: Run** `rtk go test ./modules/project/ -run 'RiskRecompute|MoveDropsRiskLinks|DeletedTaskHidden'`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`recomputeRisks`** loads, per project:
    - the live tasks (`id, planned_hours, date_start, deadline, closed`)
    - the live dependencies whose two ends are live
    - `project.planned_hours`
    - the live risks
    - the live links of live tasks

    It then calls `riskSeverity` and runs `UPDATE project_risk SET severity_computed=$1, severity_note=$2, updated_at=now() WHERE id=$3 AND (severity_computed IS DISTINCT FROM $1 OR severity_note IS DISTINCT FROM $2)`.
  - **`RecomputeOnRead`** recomputes the project from `filter[project_id]`, or from the stored risk's project on `/:id`, or every project when unpinned, then calls `next`. It runs unscoped, but writes only derived columns.
  - **`RecomputeAfterWrite`** resolves the project before `next`: from the stored row on PUT/DELETE/restore, so a delete still knows it; from the body's `project_id` (risk) or the risk's project (link) on POST. It runs `next` into a buffered response recorder. On a 2xx it calls `recomputeRisks`, then:
    - for a `project_risk` POST/PUT, it answers with the generic `GetByID` of the written id, so the response carries the fresh `severity_computed`/`criticity` (`TestRiskRecompute_ImpactChange` asserts on it)
    - otherwise it flushes the buffered response unchanged
  - **`moveTask`**: in the same tx, `UPDATE project_risk_task SET deleted_at = now() WHERE task_id IN (tree) AND deleted_at IS NULL`, and `UPDATE project_risk SET phase_task_id = NULL WHERE phase_task_id IN (tree)`.

- [ ] **Step 4: Run** the tests, then the whole package `rtk go test ./modules/project/`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(project): compute risk severity on every risk read and write`

### Task 5: Engine — `risk` display mode plumbing

**Files:**
- Modify: `core-front/packages/core-front/src/api/view-fields.ts` (`RiskConfig`, `ViewModeDefaults.risk`, `EffectiveViewFields.risk`, `effectiveViewFields`, `DisplayMode`, `DISPLAY_MODES`, `availableDisplayModes`)
- Modify: `core-front/packages/core-front/src/views/renderers.tsx:900-910` (`MODE_LABELS.risk = 'Risk'`), `:1019` (pin fallback like obs), `:1244` (render branch)
- Modify: `core-front/packages/core-front/src/views/lazy-widgets.tsx` (`RiskRenderer` lazy export)
- Create: `core-front/packages/core-front/src/views/risk/risk-renderer.tsx` (placeholder export, filled in Task 6)
- Test: `core-front/packages/core-front/src/api/view-fields.test.ts`, `src/views/renderers.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface RiskConfig { entity: string; linkEntity: string; categoryEntity: string; projectField: string; formPath: string }
  export interface RiskRendererProps { config: RiskConfig; projectId: string }
  ```
  `availableDisplayModes(...).risk` = `effective.risk != null && pinnedId(options, effective.risk.projectField) != null`.

- [ ] **Step 1: Write failing tests:**
  - `view-fields.test.ts`: `risk` is unavailable without `risk`, unavailable when unpinned, available with `filter[project_id]`.
  - `renderers.test.tsx`: with the risk config and a pinned filter, the switcher shows `Risk`. A persisted `risk` mode with no pin renders List.

- [ ] **Step 2: Run** `rtk vitest run src/api/view-fields.test.ts src/views/renderers.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** the plumbing listed under Files, mirroring every `obs` line.

- [ ] **Step 4: Run** the tests and `rtk tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(core-front): risk display mode plumbing`

### Task 6: Risk mode — matrix, Ishikawa, register

**Files:**
- Create: `core-front/packages/core-front/src/views/risk/scoring.ts`
- Create: `core-front/packages/core-front/src/views/risk/risk-matrix.tsx`
- Create: `core-front/packages/core-front/src/views/risk/ishikawa.tsx`
- Create: `core-front/packages/core-front/src/views/risk/risk-register.tsx`
- Modify: `core-front/packages/core-front/src/views/risk/risk-renderer.tsx`
- Test: `scoring.test.ts`, `risk-renderer.test.tsx` (same folder)

**Interfaces:**
- Consumes: `RiskRendererProps` (Task 5); `useRelationOps().listPage` / `list`; `exportPng`/`exportPdf(viewport, bounds, filename)` from `../diagram/export`; `useT`; `ErrorAlert`.
- Produces:
  ```ts
  export type Band = 'low' | 'medium' | 'high'
  export function band(criticity: number | null): Band | null      // ≤4 low, ≤12 medium, else high
  export interface RiskRow { id: string; name: string; category_id: string | null; likelihood: number | null; severity_effective: number | null; criticity: number | null; residual_likelihood: number | null; residual_severity: number | null; residual_criticity: number | null; impact_on: string; severity_note: string | null }
  export function matrixCells(rows: RiskRow[], residual: boolean): Map<string, RiskRow[]> // key `${likelihood}:${severity}`; rows missing either are skipped
  export function ishikawaBones(rows: RiskRow[], categories: { id: string; name: string }[]): { id: string | null; name: string; risks: RiskRow[] }[] // categories in name order, an "Uncategorized" bone last if any, risks by criticity desc, nulls last
  ```

- [ ] **Step 1: Write failing tests:**
  - `scoring.test.ts`:
    - `band`: null→null, 4→low, 5→medium, 12→medium, 13→high
    - `matrixCells` puts residual rows by residual scores and skips a row with a null severity
    - `ishikawaBones` orders bones and risks as specified
  - `risk-renderer.test.tsx`, mocking RelationOps:
    - the three tabs render
    - the Matrix shows a chip `6` in cell 2:3
    - the "After remediation" toggle moves it to 1:1
    - Ishikawa shows one bone per category with the risk names
    - clicking a risk navigates to `formPath` with the id
    - a risk with `severity_note` shows "Not computable" in the register
    - a failed read shows the `ErrorAlert`
    - the Export menu calls `exportPng` on Matrix and on Ishikawa

- [ ] **Step 2: Run** `rtk vitest run src/views/risk`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - The renderer reads all risks with `filter[projectField]=projectId`, paged 200 until a short page (the read recomputes server-side), and reads the categories once.
  - Matrix: an MUI grid, likelihood rows 3→1 and severity columns 1→4, each cell tinted by `band(likelihood × severity)`, chips coloured by `band(criticity)`.
  - Ishikawa: hand-drawn SVG. The spine runs to a head box carrying the project name. Bones alternate above and below the spine, risk labels sit along each bone, and a bone with more than 8 risks shows "+N more".
  - Register: a plain MUI `Table` of the AMDEC columns.
  - Navigate with the router the other diagrams use (`erpPath`).

- [ ] **Step 4: Run** the tests and `rtk tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(core-front): risk matrix, Ishikawa and register tabs`

### Task 7: Engine widget `text/mindmap` (risk form header)

**Files:**
- Modify: `core-front/packages/core-front/src/views/descriptor.ts:107` (add `'mindmap'` to `FIELD_WIDGETS.text`)
- Create: `core-front/packages/core-front/src/views/mindmap-widget.tsx`
- Modify: `core-front/packages/core-front/src/views/widgets.tsx` (dispatch `text/mindmap`)
- Test: `core-front/packages/core-front/src/views/mindmap-widget.test.tsx`

**Interfaces:**
- Produces: the widget options `{ satellites: [{ field: string; label: string; under?: string }] }`. Each satellite shows the label, the field's value (a many2one shows its record label through the same label hook the search bar chips use, `useRelationLabels`), and an optional `under` field's value as a second line. The centre box shows the field's own value. The widget is read-only, with an Export PNG button (`exportPng`).

- [ ] **Step 1: Write the failing test.** For a form draft `{ name: 'Budget cut', description: 'Client trims scope', category_id: <id>, phase_task_id: <id> }`:
  - the widget renders the centre `Budget cut`, a satellite `Risk category` with the resolved category name, `Risk type` with the description, and `Project phase` with the resolved task name
  - an empty satellite shows `—`

- [ ] **Step 2: Run** `rtk vitest run src/views/mindmap-widget.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.** Find how `widgets.tsx` hands sibling field values to a widget (the `address` composite reads several columns, so follow its access path). Draw the boxes and lines in SVG.

- [ ] **Step 4: Run** the test plus `src/views/descriptor.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(core-front): read-only mind-map field widget`

### Task 8: Project views, menu, i18n, demo seed

**Files:**
- Modify: `core/modules/project/views/project_views.ts`:
  - the risk list and form descriptors
  - routes `/project/risks`, `/project/risks/:id`, `/project/risk_categories`, `/project/risk_categories/:id`
  - menu entries *Risks* (main) and *Risk categories* (`registerHeaderMenu('project','configuration', …)`)
  - `viewModeDefaults.risk` on `tasksList` (around line 171): `{ entity: 'project_risk', linkEntity: 'project_risk_task', categoryEntity: 'project_risk_category', projectField: 'project_id', formPath: '/project/risks/:id' }`
- Modify: `core/modules/project/i18n/project.pot`, `fr.po` (every new label)
- Modify: `core-front/apps/shell/src/lib/dev-seed.ts` (in `seedProjects`: 3 risks per large project — one delay with 2 links, one cost with 1 link, one quality — after the tasks)
- Test: `core/modules/project/views/project_views.test.ts`, `core-front/apps/shell/src/lib/dev-seed.test.ts`

**Interfaces:**
- Consumes: `RiskConfig` (Task 5) and the `text/mindmap` widget (Task 7).
- Risk form layout:
  - header: the `name` field as the `text/mindmap` widget, with satellites `category_id` "Risk category", `description` "Risk type", `phase_task_id` "Project phase"
  - group *Assessment*: impact_on, likelihood, detectability, severity_computed (read-only), severity_note (read-only), severity, criticity (read-only)
  - group *Remediation*: remediation, residual_*, residual_criticity (read-only), responsible_id, deadline
  - notebook page *Linked tasks*: one2many `project_risk_task` (task_id, delay_days, extra_hours)
- `phase_task_id`: many2one to `project_task` with `filter` limited to the project and `empty[parent_id]` (if relation `filter` can't express `empty`, leave it unfiltered — the server's 422 still guards it).
- `likelihood`/`detectability`/severity fields are `selection` fields with labelled options from the legend (e.g. `{value: 2, label: 'Likely'}`), as the spreadsheet shows words.

- [ ] **Step 1: Write failing tests:**
  - `project_views.test.ts`: the risk routes exist; tasks list `viewModeDefaults.risk` equals the config above; the risk form has the mindmap header and the Linked tasks page.
  - `dev-seed.test.ts`: the seed POSTs 3 `project_risk` rows per large project, then their links.

- [ ] **Step 2: Run** `rtk vitest run` in `core/modules/project` and `core-front/apps/shell` (filtered to those files). Expected: FAIL.

- [ ] **Step 3: Implement** the descriptors, menu, `.pot`/`.po` entries and seed.

- [ ] **Step 4: Run** the tests and `rtk pnpm -C core-front lint`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(project): risk list, form, menu and demo risks`

### Task 9: Docs and full gate

**Files:**
- Create: `docs/adr/ADR-040-risk-analysis.md`. Cover:
  - why risks live in the project
  - the scoring legend
  - severity per `impact_on`
  - the recompute-on-read decision and its pitfall
  - why the critical path is computed in Go and TS, guarded by the shared fixture
  - a Mermaid diagram: risk → links → tasks → forward pass → severity → criticity
- Modify: root `CLAUDE.md`, the `core/modules/project` paragraph (new tables, rules, recompute, pitfalls)
- Modify: `core-front/CLAUDE.md`, the list display modes row (`risk` key, `text/mindmap` widget)
- Modify: `docs/adr/ADR-039-diagram-views.md` (a "See also ADR-040" line under PERT conventions)

- [ ] **Step 1: Write the docs.**

- [ ] **Step 2: Run** `rtk make test`. Expected: every stage green, coverage floors met (core 85%, frontend 80%).

- [ ] **Step 3: Run** `graphify update .`

- [ ] **Step 4: Commit** `docs(project): ADR-040 risk analysis`
