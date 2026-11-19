# Project OBS Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An OBS (organizational breakdown structure) display mode beside WBS and PERT on the project task lists. It is a hand-built chart, one per project: boxes for a contact, an ERP user or free text, each with its own background color, linked into a hierarchy.

**Architecture:** A project gets an optional `company_id` (a `contact` of kind `company`). The chart is stored in one shared, row-scoped table, `project_obs_box`, one row per box. Each row holds the box's kind, its contact or user, its text, `color`, `parent_id` (the hierarchy line) and `x`/`y` (its position, shared by everyone, unlike WBS/PERT's per-user layout). The engine's `DiagramCanvas` gains a controlled-positions mode. A new `ObsRenderer` draws the boxes and lines, and `TreeRenderer` offers the `obs` mode only when the list is filtered to exactly one project.

**Tech Stack:** Go (core ORM, generic CRUD + project guards, Postgres), React 19 + MUI + `@xyflow/react` (engine `@eerp/core-front`), vitest.

**Spec:** this plan's *Decisions* section (taken from the user's answers on 2026-11-13). Read with [ADR-038](../../adr/ADR-038-row-level-access.md) (row scope) and [ADR-039](../../adr/ADR-039-diagram-views.md) (diagram views).

## Decisions

- **Owner:** the project. The project form gets a *Company* field (`company_id` → `contact`, kind `company`, optional). Each project has its own chart; the company only narrows the contact picker.
- **Placement:** an `OBS` button in the task lists' display-mode switcher (`/project/tasks`, `/project/my-tasks`), shown only while the list's filters pin `project_id` to one id (the link from a project form does: `/project/tasks?filter[project_id]=<id>`).
- **Access:** shared, by project rights. Anyone who sees the project sees its chart. The project's manager or a project admin edits it (the same rule as stages and members, `managedChildRules`).
- **Box kinds:** `contact` (a contact picked from the project company's people, or from every person when the project has no company), `user` (an ERP staff user), `text` (free text only). Every box also has an optional `title` (the role, e.g. "Sponsor").
- **Colors:** free `#rrggbb` per box through a native color input, stored lowercase, validated server-side (422 otherwise, like `project_color`). The text color is `theme.palette.getContrastText(color)`. No color means the theme's paper color.

## Global Constraints

- Go code: no `fmt`/`log` (depguard), zap via `common.Logger`, table-driven tests with `t.Run`. DB tests seed under a fresh `uuid.New()` tenant and clean up only their rows (`testdb.Open`, `testdb.MigrateModules(t, app, "auth", "contact", "project")`).
- Search with `rg`, never `grep`.
- Strings go through `t()` / `useT()`. Each new msgid goes in `core/modules/project/i18n/project.pot` + `fr.po` (module strings). Shell chrome strings go in `core-front/apps/shell/i18n/`.
- Icons only from `views/icons.ts`. Add any missing one as a named import.
- A Server Action never throws a Go error (`settleAction`). The engine reaches Go only through `RelationOps`.
- Coverage floors: core 85% total, engine and shell 80% each (`make test`). New code ships with its tests.
- Docs: update ADR-039 (new *OBS* section), the root `CLAUDE.md` project bullet and `core-front/CLAUDE.md`'s List display modes row in the task that changes the behavior.
- Commits: `<type>(scope): <description>`, identity `git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com`, ending with the `Co-Authored-By` line.

## Review Focus

1. **A box whose contact/user is later deleted or becomes invisible:** the box stays and shows "Deleted contact" / "Unknown user", never an id or a crash. Test in Task 5.
2. **Deleting a box that has children:** the children's `parent_id` is cleared in the same transaction (they become roots), never a dangling line nor a 409. Test in Task 2.
3. **Parent cycles** (A under B, then B under A) and a parent in another project: 422. Test in Task 2.
4. **A member who isn't the manager drags a box:** the move is refused (403) and the box snaps back with the error shown, never silently kept on screen only. Test in Task 5.
5. **The list filter changes from one project to another (or to none) while OBS is shown:** the mode shows the new project's chart, or falls back to List when no single project is pinned. Test in Task 4.

---

### Task 1: Project company field

**Files:**
- Modify: `core/modules/project/models.go` (`Project`), `core/modules/project/module.json` (`depends: ["auth", "contact"]`), `core/modules/project/validate.go` (`projectRules`)
- Modify: `core/modules/project/views/project_views.ts` (`projectFormFields`)
- Test: `core/modules/project/validate_test.go`, `core/modules/project/views/project_views.test.ts`

**Interfaces:**
- Produces: column `project.company_id` (nullable uuid, `db:"company_id,index" json:"company_id"`, Go type `*uuid.UUID`); form field `company_id` (relation many2one → `contact`, `labelField: 'name'`, `filter: { kind: 'company' }`, label `'Company'`).

- [ ] **Step 1: Write the failing tests.** `TestProjectRules_Company` (table-driven): create with a company contact → 201 and the value round-trips; with a contact of kind `contact` → 422 naming `company_id`; with an id from another tenant → 422; with `null` → 201. The views test asserts the project form descriptor has a `company_id` field whose `relation.filter` is `{ kind: 'company' }`.
- [ ] **Step 2: Run** `CONFIG=$PWD/../../eerp-config.json go test -timeout 120s ./modules/project/ -run Company` (from `core/`, Go on PATH). Expected: FAIL.
- [ ] **Step 3: Implement.** Add the field. In `projectRules`, when `company_id` is set and changed, check `SELECT kind FROM contact WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL` = `'company'`, else `invalid("company_id", "company_id must be a company contact")`. Add `company_id` to the form after `manager_id`.
- [ ] **Step 4: Run** the Go test and `npx vitest run` in `core/modules/project`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): company contact on projects`.

### Task 2: `project_obs_box` table and its rules

**Files:**
- Modify: `core/modules/project/models.go` (new `ProjectObsBox`), `module.go` (register), `scope.go` (reuse `ChildScope`), `validate.go` (`obsRules`, `ValidateObsBody`), `handler.go` (`Mount` guard map + `DeleteObsBox`), `migrate.go` (no trigger needed; add the index below)
- Test: `core/modules/project/obs_test.go`

**Interfaces:**
- Produces (Go, table `project_obs_box`, generic CRUD at `/api/v1/project_obs_box`):

```go
type ProjectObsBox struct {
	model.BaseModel
	TenantID  uuid.UUID  `db:"tenant_id"`
	ProjectID uuid.UUID  `db:"project_id,index" json:"project_id"`
	ParentID  *uuid.UUID `db:"parent_id,index" json:"parent_id"`
	Kind      string     `db:"kind" json:"kind"`             // "contact" | "user" | "text"
	ContactID *uuid.UUID `db:"contact_id" json:"contact_id"` // kind contact only
	UserID    *uuid.UUID `db:"user_id" json:"user_id"`       // kind user only
	Title     *string    `db:"title" json:"title"`           // the role, ≤ 200 chars
	Text      *string    `db:"text" json:"text"`             // ≤ 2000 chars
	Color     *string    `db:"color" json:"color"`           // "#rrggbb" lowercase or null
	X         float64    `db:"x" json:"x"`
	Y         float64    `db:"y" json:"y"`
}
```

- [ ] **Step 1: Write the failing tests** (`TestObsBoxRules`, table-driven, as the manager unless stated):
  - create `text` with `x`/`y` → 201;
  - `contact` without `contact_id`, `user` with a `contact_id`, an unknown `kind` → 422;
  - `contact_id` of another tenant, `user_id` of a website user → 422;
  - `color: "#FFAA00"` → stored `"#ffaa00"`; `"red"` → 422;
  - `title` of 201 chars → 422;
  - `parent_id` in another project → 422; A→B then B→A → 422 (cycle); `parent_id` = own id → 422;
  - `project_id` change on update → 422 (`fixedProject`);
  - a member who isn't the manager: create/update/delete → 403; reading the list → 200;
  - a non-member of a members-only project: list → 0 rows, get → 404;
  - delete a box with two children → 204, both children now have `parent_id = null`, same `deleted_at` not required.
- [ ] **Step 2: Run** `go test -timeout 120s ./modules/project/ -run ObsBox`. Expected: FAIL.
- [ ] **Step 3: Implement.** Register `orm.Register[ProjectObsBox](orm.WithTableName("project_obs_box"), orm.WithRowScope(ChildScope(p)))`. `obsRules = managedChildRules(extra)`. In `extra`: default `x`/`y` to 0; enforce the kind/ref pairing; check that `contact_id` is a live contact of the tenant and `user_id` a live staff user (`users.kind = 'staff'`); lowercase and validate the color with the same check `project_color` uses (reuse its helper); check that `parent_id` is a live box of the same project; cycle check: walk up from the new parent with a recursive CTE and refuse when it reaches the box's own id. `DeleteObsBox`: one `orm.Transact` that clears `parent_id` of the live children, then soft-deletes the box (`requireManage` first, 404 when invisible). Add `"project_obs_box": h.ValidateObsBody` to the guard map and `case "project_obs_box": del = h.DeleteObsBox`.
- [ ] **Step 4: Run** the tests, then `go vet ./modules/project/` and `make run-deadcode`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(project): OBS boxes table with manager-only writes`.

### Task 3: `DiagramCanvas` controlled positions

**Files:**
- Modify: `core-front/packages/core-front/src/views/diagram/diagram-canvas.tsx`
- Test: `core-front/packages/core-front/src/views/diagram/diagram-canvas.test.tsx`

**Interfaces:**
- Produces: `DiagramCanvasProps.mode: 'wbs' | 'pert' | 'obs'`, plus two optional props:
  - `positions?: Record<string, Point>`: when given, the canvas is **controlled**. It never calls `getViewLayout`/`saveViewLayout`, starts `loaded`, and takes these as the fixed positions.
  - `onMove?: (moved: Record<string, Point>) => boolean | void | Promise<boolean | void>`: called after a drop (one box or a selection) with each moved box's free spot. `false` (now or once resolved) puts them back where they were before the drag.
  - Re-arrange in controlled mode calls `onMove` with every drawn box's auto-layout spot.

- [ ] **Step 1: Write the failing tests.** `it('controlled positions: no layout read or save, drops reported to onMove')`: with `positions={{a: at(10,10), b: at(500,500)}}` and `onMove = vi.fn(() => true)`, `getViewLayout` and `saveViewLayout` are never called, `pos('a')` is `at(10,10)`, a drag of `a` to `at(40,40)` calls `onMove` with `{ a: at(40,40) }`. `it('controlled positions: a refused move snaps back')`: `onMove` resolving `false` puts `a` back at `at(10,10)`.
- [ ] **Step 2: Run** `npx vitest run src/views/diagram/diagram-canvas.test.tsx` (in `packages/core-front`). Expected: FAIL.
- [ ] **Step 3: Implement.** Use `props.positions` as `positions` and skip the layout effect and `scheduleSave` when it's defined. The single-drop and group-drop paths call `onMove` with the spots they compute and reuse the existing `putBack` logic for `false`. `onNodeDrop` is still called for a single drop, as today.
- [ ] **Step 4: Run** the diagram tests. Expected: PASS (all existing tests unchanged).
- [ ] **Step 5: Commit** `feat(core-front): controlled positions on the diagram canvas`.

### Task 4: `obs` display mode in the engine

**Files:**
- Modify: `core-front/packages/core-front/src/api/view-fields.ts` (`ViewModeDefaults.obs`, `EffectiveViewFields.obs`, `DisplayMode`, `DISPLAY_MODES`, `availableDisplayModes`), `src/views/renderers.tsx` (switcher label + branch), `src/views/lazy-widgets.tsx` (`ObsRenderer`)
- Test: `src/api/view-fields.test.ts`, `src/views/renderers.test.tsx`

**Interfaces:**
- Consumes: `ObsRendererProps` (Task 5).
- Produces:

```ts
/** Module-declared only. */
export interface ObsConfig { entity: string; projectField: string; projectEntity: string; companyField: string; canEdit?: string }
// ViewModeDefaults.obs?: ObsConfig ; EffectiveViewFields.obs: ObsConfig | null
export type DisplayMode = 'list' | 'kanban' | 'calendar' | 'graph' | 'gantt' | 'wbs' | 'pert' | 'obs'
export function availableDisplayModes(effective: EffectiveViewFields, options?: EntityListOptions): Record<DisplayMode, boolean>
/** The one id `options` pins `field` to (filter[field]=id, or in[field] with one id), else null. */
export function pinnedId(options: EntityListOptions | undefined, field: string): string | null
```

- [ ] **Step 1: Write the failing tests.** `pinnedId` returns the id for `{ filter: { project_id: 'p1' } }` and for `{ in: { project_id: ['p1'] } }`, and returns `null` for none, for two ids, or for `''`. `availableDisplayModes` reports `obs` true only when `effective.obs` is set and `pinnedId(options, obs.projectField)` is non-null. Renderer: with `viewModeDefaults.obs` and a `filter[project_id]` seeded from the URL, the switcher shows `OBS` and choosing it renders the mocked `ObsRenderer` with `projectId="p1"`. Clearing the filter falls back to List content (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run src/api/view-fields.test.ts src/views/renderers.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** `effectiveViewFields` copies `defaults?.obs ?? null`. `TreeRenderer` calls `availableDisplayModes(effective, baseOptions)`, labels the button `t('OBS')`, and renders `<ObsRenderer config={effective.obs} projectId={pinnedId(baseOptions, effective.obs.projectField)!} />` with `key={projectId}` so another project remounts it. Add the lazy wrapper beside `PertRenderer`.
- [ ] **Step 4: Run** the tests and `rtk tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core-front): OBS display mode for a list pinned to one record`.

### Task 5: `ObsRenderer` and its boxes

**Files:**
- Create: `core-front/packages/core-front/src/views/diagram/obs-renderer.tsx`, `obs-box.tsx`
- Modify: `src/views/icons.ts` if an icon is missing (`user`, `address-book`, `font`, `palette`, `trash`)
- Test: `src/views/diagram/obs-renderer.test.tsx` (mock `@xyflow/react` like `pert-renderer.test.tsx`)

**Interfaces:**
- Consumes: `DiagramCanvas` with `positions`/`onMove` (Task 3); `ObsConfig` (Task 4); `RelationOps.listPage/get/create/update/remove`; `kanbanColumnsGuard(config.canEdit)` (existing, `kanban-columns.ts`) for the edit right.
- Produces: `export interface ObsRendererProps { config: ObsConfig; projectId: string }`, `export function ObsRenderer(props: ObsRendererProps)`, and `export const OBS_BOX_SIZE = { w: 220, h: 110 }`.

Behavior the tests pin:
- Loads every box with `listPage(config.entity, { filter: { [projectField]: projectId }, order: 'created_at', pageSize: 200, page })` until a short page. A refused read shows `ErrorAlert`.
- Each box shows its color as background (contrast text), its `title` (bold), then by kind: the contact's `name` + `email`, the user's `display_name` (else `email`), or the `text`. Labels come from `ops.get` (cached per id), and a failed read shows `t('Deleted contact')` / `t('Unknown user')` (Review Focus 1).
- Lines: one edge per box with a live `parent_id` (parent → child, `smoothstep`, no arrowhead). With the edit right: connecting A → B `update`s B's `parent_id = A` (a 422 shows the error and draws nothing), and deleting a selected line sets `parent_id: null`.
- Toolbar (`toolbarExtra`, edit right only): *Add contact*, *Add user*, *Add text*. Each opens a small dialog: a picker (contact: `listPage('contact_company', { filter: { company_id } })` then `contact` `in[id]`, or `listPage('contact', { filter: { kind: 'contact' }, search: { name } })` when the project has no `company_id`, read once with `ops.get(config.projectEntity, projectId)`; user: `listPage('users', { search: { email } })`), then *Role* (`title`) and, for text, a multiline *Text*. Create posts `{ project_id, kind, contact_id|user_id, title, text, x, y }` at the view center (`freeSpot`).
- On each box (edit right): a palette button with a native `<input type="color">` that `update`s `color` on change, a *Clear color* entry, a trash button that `remove`s the box (its children become roots on the next read), and double-click to edit title/text in the same dialog.
- Moves: `onMove` → one `update(entity, id, { x, y })` per moved box. A refusal returns `false`, so the canvas snaps back, and shows the error (Review Focus 4).
- Without the edit right: no toolbar buttons, no box buttons, no connecting, and dragging is off (`nodesDraggable` false through a new `readOnly` prop on `DiagramCanvas`, added in this task).
- Auto-layout: `layoutWbs` over `parent_id` (roots in creation order), used by Re-arrange and for boxes with no saved position (`x = y = 0` and never moved).

- [ ] **Step 1: Write the failing tests** named after the bullets above (one `it` per bullet).
- [ ] **Step 2: Run** `npx vitest run src/views/diagram/obs-renderer.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** `obs-box.tsx` (`ObsBox` node type, `memo`, `useDetailed` far view = title only) and `obs-renderer.tsx` as specified.
- [ ] **Step 4: Run** `npx vitest run src/views/diagram`, `rtk tsc --noEmit -p .` and `npx eslint src/views/diagram`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core-front): OBS renderer with contact, user and text boxes`.

### Task 6: Wire OBS into Project, docs and translations

**Files:**
- Modify: `core/modules/project/views/project_views.ts` (`taskViewModeDefaults.obs`), `core/modules/project/i18n/project.pot`, `fr.po`, `core-front/apps/shell/i18n/shell.pot` + `fr.po` (engine strings: `OBS`, `Add contact`, `Add user`, `Add text`, `Role`, `Text`, `Clear color`, `Deleted contact`, `Unknown user`, `Delete box`, `Background color`), `docs/adr/ADR-039-diagram-views.md`, `CLAUDE.md`, `core-front/CLAUDE.md`, `core-front/apps/shell/src/lib/dev-seed.ts` (`seedProjects`: set `company_id` on one small project and create a 5-box OBS: sponsor contact, manager user, two team members, one text note, two colors)
- Modify: `DiagramHelp` in `diagram-canvas.tsx`: an OBS tip (`Add boxes from the toolbar; drag from a box's dot to another to put it under that one.`) when `mode === 'obs'`
- Test: `core/modules/project/views/project_views.test.ts`, `core-front/apps/shell/src/lib/dev-seed.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `taskViewModeDefaults.obs = { entity: 'project_obs_box', projectField: 'project_id', projectEntity: 'project', companyField: 'company_id', canEdit: 'project.canEditStages' }`.

- [ ] **Step 1: Write the failing tests.** The views test asserts the task list descriptors carry that `obs` config. The dev-seed test asserts the seed posts 5 `project_obs_box` rows for the project with a company, with at least one non-null `color`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the config, the seed and the translations. Docs: ADR-039 gets an *OBS* section (why the chart is shared while WBS/PERT layouts are per user, the manager-only edit rule, why the mode needs one pinned project), the root `CLAUDE.md` project bullet lists `project_obs_box`, `company_id` and the delete-clears-children rule, and `core-front/CLAUDE.md`'s List display modes row adds `obs` (`pinnedId`, controlled `DiagramCanvas`).
- [ ] **Step 4: Run** `make test`. Expected: every suite green and every coverage floor met.
- [ ] **Step 5: Run** `graphify update .` and commit `feat(project): OBS chart beside WBS and PERT`.
