# Project app — design

**Date:** 2026-11-09 · **Status:** draft, awaiting approval

## Intent

Give EERP an Odoo-style **Project** app: staff organise work into projects, break it into
tasks they move across a kanban board, nest subtasks, mark dependencies, group work under
milestones and log the hours they spend, so planned time can be compared with time spent.

Odoo's `project` module is the reference for behaviour and vocabulary. Where this document
doesn't say otherwise, do what Odoo does.

## Goals

1. **Projects.** Each project has a name, a description, a manager (a staff user), members
   (staff users), optional start and end dates, and a **visibility** setting:
   - `everyone`: every staff user with the app's read permission sees it.
   - `members`: only its manager and members see it, and its tasks.
2. **Per-project stages** (Odoo's task stages). Every project owns an ordered list of stages
   that users add, rename, reorder and delete. A stage can be flagged **closed** ("folded" in
   Odoo): its tasks count as finished, and its kanban column is collapsed. A new project gets
   default stages: *New, In progress, Done (closed)*. Deleting a stage that still holds tasks
   is refused (409).
3. **Tasks.** Each task has a title, a description (long text), a project, a stage of that
   project, **assignees** (several staff users), **tags**, a **priority** (starred or not),
   a **deadline**, **planned hours**, a **milestone** of the same project (optional) and a
   **parent task** (optional). A task created without a stage lands in the project's first
   stage.
4. **Kanban grouped by stage records.** The task kanban shows one column per stage of the
   project being viewed, ordered by the stages' sequence, with closed stages collapsed.
   Dragging a card changes its `stage_id`. From the board, users can add a column (a new
   stage), rename one, and reorder them. This is new engine capability: the kanban today only
   groups by a `selection` field's fixed options.
5. **Subtasks.** A subtask is a full task with `parent_id` set, in the same project as its
   parent. The parent's form lists its subtasks (an editable one2many table) with a
   done/total count. Subtasks are also full rows in the task list and kanban. A task can't be
   its own ancestor (cycle → 422).
6. **Dependencies ("blocked by").** A task lists the tasks it is blocked by. Any task the
   caller can see is allowed, including one from another project. The reverse list
   ("blocking") shows on the other task's form. A task is **blocked** while at least one of
   its blockers sits in a non-closed stage. Blocked shows as a badge on the card and the form,
   and never prevents any move or edit. Cycles are refused (422).
7. **Milestones.** Each project has milestones with a name, a deadline and a **reached**
   checkbox (with the date it was reached). A milestone's form lists its tasks with a
   done/total count. The project form lists its milestones.
8. **Timesheets.** One line = user, task (its project is denormalized on the line), date,
   hours, description. Lines are entered in a table on the task form and also have their own
   list (with graph and grouping, like any generic list). The task shows **planned**,
   **spent** (sum of its own lines; Odoo also adds subtasks' hours as a separate "sub-tasks
   hours" figure, so do the same), and **remaining** = planned − spent (can go negative).
   The project shows totals over its tasks.
9. **Privacy enforced on the server.** A non-member can't see a `members` project or anything
   belonging to it (tasks, stages, milestones, timesheets, dependencies, assignee links) from
   a list, kanban, search, group-by, graph aggregate, direct `/:id` link, update or delete.
   The answer is a 404, never a 403. A write can't attach a record to a project the caller
   can't see.

## Non-goals

Customer portal and sharing, recurring tasks, burndown and other reports beyond the generic
Graph view, timesheet invoicing or payroll, rating, email aliases, task templates, Gantt,
"personal stages" (Odoo's per-user My Tasks stages), project favourites, followers and
activities. Records still get the generic chatter, like every EERP form.

## Anti-goals (a failure even if it "works")

- A private project's task, timesheet or name leaking through any generic route: `distinct`,
  `aggregate`, the Redis read cache, a relation widget's autocomplete, or a dependency's
  label shown to a non-member.
- Blocking a task's movement because of dependencies.
- Stages being a fixed code-level list.

## Decisions

### Decided with the user

- Feature set: projects, tasks, kanban, subtasks, dependencies, milestones, timesheets.
- Timesheets only compare spent with planned hours. Nothing is invoiced or paid.
- Project visibility: public (everyone) or members only, like Odoo.
- Stages are editable per project, like Odoo.
- Dependencies only show "blocked". They never prevent anything.

### Decided by Claude (the user may override)

- **Module.** `core/modules/project`, `type: go`, `app_mode: true`, `menu_icon` a
  kanban/clipboard icon, frontend descriptors in `views/`, `i18n/` with `project.pot` and
  `fr.po`. Business logic in `core/modules/project/internal` (like crm/event). Every table
  rides the **generic CRUD surface**, so list, kanban, calendar and graph come for free.
  Overrides and validation middleware are added only where invariants need them (the event
  module's pattern).
- **Tables** (all `BaseModel`, all tenant-scoped like the other generic tables):
  `project`, `project_member` (project_id, user_id; unique live pair),
  `project_stage` (project_id, name, sequence, closed),
  `project_task` (project_id, stage_id, parent_id, milestone_id, name, description, priority,
  deadline, planned_hours, sequence),
  `project_task_user` (task_id, user_id; assignees),
  `project_tag` (name, shared by every project, not private),
  `project_task_tag` (task_id, tag_id),
  `project_task_dependency` (task_id, depends_on_id, project_id = task's),
  `project_milestone` (project_id, name, deadline, reached, reached_at),
  `project_timesheet` (project_id, task_id, user_id, date, hours, description).
  **Every project-owned table carries `project_id`**, denormalized where needed and kept
  consistent by the write middleware, so a single row rule (below) covers all of them.
  Unique indexes are hand-written in `Migrate()`.
- **Computed figures** (`spent_hours`, `subtask_hours`, `blocked`, subtask/milestone
  done/total counts): the builder chooses between stored columns kept up to date by the write
  overrides and values computed on read, as long as kanban cards and lists show them without
  N+1 requests and lists can filter on `blocked`. Recommendation: stored, recomputed in the
  same transaction as the write that changes them. That includes a blocker changing stage,
  which re-flags its dependents.
- **Row-level access: a new ORM capability.** No existing mechanism restricts generic CRUD
  rows per staff caller (`PublicScope`'s forced filter is equality-only and public-only). Add
  a registration option, something like `orm.WithRowScope(func(ctx) (orm.Condition, bool))`.
  It returns a SQL condition, with bound parameters, that the generic repository ANDs into
  **every** read (list, `/:id`, distinct, aggregate, relation autocomplete), and into update
  and delete WHERE clauses. That way an invisible row is a 404 at the same choke points that
  already enforce `PublicScope`. A table with a row scope is **never served from the Redis
  read cache**, because its result depends on the caller and on other tables. Record this
  as **ADR-038** and in `core/orm/README.md`.
  - Project rule: `visibility = 'everyone' OR manager_id = caller OR caller is a live
    project_member OR caller is a project admin`. Child tables: `project_id IN (visible
    projects)`.
  - **Assignees, like Odoo (decided with the user):** a task is also visible to its
    assignees even when its project isn't, and so are its own rows (its timesheets, its
    dependency and assignee/tag links). Its subtasks and the project itself are not, unless
    the caller is assigned to them too. Such a caller sees the project's name only as the
    label on their task. The project, its stages and its milestones stay invisible to them.
    On such a task's kanban the columns come from the stages the caller can't otherwise list,
    so the many2one kanban must get the columns through the visible task's project.
    The builder picks the cleanest way, e.g. stage rows visible when the caller can see any
    task of that project. Assigning a user does not make them a member.
  - **Record-anchored services (decided with the user):** `internal/chatter`,
    `internal/notebook`, `internal/attachments` and `internal/pictures` must stop leaking
    rows anchored on a record the caller can't see. Expose a check from the ORM, something
    like `orm.CanSeeRecord(ctx, table, id)` that evaluates the table's row scope (true for
    tables without one), and call it on every read and write of those services. A record
    that can't be seen gets a 404. Tables without a row scope behave exactly as today.
    Include the public picture route only if it can reach a row-scoped table (it can't
    today, since project tables are never published).
  - **Project admin:** a caller whose groups include the role technical name
    `project_admin`, or who holds `*:*:*`, sees every project. The module seeds no role.
    Admins create it, or the builder seeds `project_admin` per tenant the way website roles
    are seeded, whichever is lighter.
  - **Writes:** a create or update middleware refuses (422) a `project_id`, `stage_id`,
    `milestone_id`, `parent_id`, `depends_on_id` or `task_id` pointing at a row the caller
    can't see or that belongs to a different project than the record (dependencies excepted:
    they may cross projects but both ends must be visible).
- **Permissions.** These are the usual route-derived `project_*:project_*:read|write|delete`
  grants, with visibility applied on top. Editing a project's own fields, members, visibility
  and stages is allowed only for its manager or a project admin (others get 403 on that write,
  or 404 if they can't see the project).
- **Timesheet authorship.** A user logs hours as themselves. Logging or editing a line for
  someone else is allowed only for the project's manager or a project admin. `user_id`
  defaults to the caller.
- **Deleting a project** that still has live tasks is refused (409), like Odoo. Archive it
  (an `active` flag; archived projects are hidden from the default list filter) or delete the
  tasks first. Deleting an empty project soft-deletes its stages, milestones and members in
  the same transaction.
- **Moving a task to another project** is allowed for a top-level task. In one transaction,
  its subtasks (recursively) and timesheets move with it, each moved task's stage is remapped
  to the new project's stage with the same name, else its first stage, and milestones are
  cleared. Dependencies stay (they may cross projects). Changing the project of a subtask
  directly is refused (422): move its parent, or clear `parent_id` first.
- **Kanban permissions.** Add, rename and reorder column controls show only to the project's
  manager or a project admin. The backend must expose that per project (e.g. a read-only
  `can_manage` on the project row, computed for the caller). Anyone who can write tasks may
  drop a card into any column, closed ones included.
- **Blocked flag** is stored (one boolean per task) and may stay true because of a blocker the
  viewer can no longer see. It reveals a yes/no, nothing about the hidden task. The
  "Blocked by" list shows only the blockers the viewer can see.
- **Frontend routes** (descriptors in `core/modules/project/views/`):
  `/project` (project list, kanban by visibility or plain cards. Builder's call),
  `/project/:id` (project form: details, members, stages table, milestones table, totals),
  `/project/tasks` (task list, kanban, calendar on `deadline`, graph),
  `/project/tasks/:id` (task form: notebook pages *Description*, *Subtasks*,
  *Blocked by / Blocking*, *Timesheets*), `/project/my-tasks` (tasks assigned to me, across
  projects), `/project/milestones[/:id]`, `/project/timesheets` (list + graph).
  From a project, an "open tasks" action lands on `/project/tasks` pre-filtered on that
  project.
- **Kanban by stage: engine extension.** Extend `kanban-renderer.tsx` (and `ViewModeDefaults`)
  so the status field may be a **many2one** whose columns come from the related entity's
  records. The descriptor names the column ordering field (`sequence`), the folded flag
  (`closed`) and the scoping field (`project_id`). Columns are fetched for the project the
  list is filtered on. With no single-project filter (My tasks, an unfiltered list), columns
  are the visible stages grouped **by stage name** across projects. Dropping a card in such a
  merged column picks the stage of that name in the card's own project, and if none exists
  the drop is refused with a message. Adding, renaming and reordering columns writes
  `project_stage` rows and is available only when the board is scoped to one project. Keep it
  generic (any many2one with a sequence), not project-specific. Existing selection kanbans
  must keep working unchanged.
- **Blocked badge, done counts and spent/planned** show on the kanban card through whatever
  card-field mechanism the engine has. Extend it minimally if a badge isn't possible today.
- **Seed data.** Add a `project` group to the dev light seed (a few projects, stages, tasks
  with subtasks/dependencies, milestones, timesheets). The full 100k volume is out of scope.
- **Docs.** ADR-038 (row scope), a `CLAUDE.md` Architecture bullet for `core/modules/project`,
  `core/orm/README.md` row-scope section, wiki/user doc if the other apps have one. French
  translations for every label.
- **Tests.** Backend tests for every invariant above (privacy across every generic route
  including distinct/aggregate/update/delete and the four record-anchored services, the
  assignee exception, project delete refusal, task move, cross-project refusals, cycles, stage delete
  refusal, blocked recompute, timesheet authorship, totals). Frontend tests for the
  many2one kanban. Coverage floors from `make test` must hold.

## Left to the builder

Exact column types and indexes, how `ProjectStage` defaults are seeded on project creation
(override vs middleware), whether totals are stored or computed (see recommendation), the
project list's visual form, icon name, migration order, and how the row-scope condition is
expressed in the ORM API, provided it binds parameters and is enforced at the repository
choke points and not only in handlers.
