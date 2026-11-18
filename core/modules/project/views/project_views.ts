import {
  FORM_COLUMNS_ID,
  FORM_HEADER_ID,
  FORM_NOTEBOOK_ID,
  kanbanColumnsGuard,
  registerFieldFunction,
  registerHeaderButtonAction,
  registerHeaderMenu,
  registerKanbanColumnsGuard,
  translate,
  useI18nStore,
  type FrontModule,
  type HeaderButtonDescriptor,
  type Operation,
  type ViewDescriptor,
} from '@eerp/core-front'

// project frontend — DESCRIPTORS ONLY. Entities map 1:1 to the Go route
// prefixes (project, project_stage, project_task, …); permissions mirror the
// route (<table>:<table>:<action>). Go owns every invariant (row scope,
// manager-only writes, task moves, read-only totals): the forms just omit or
// disable what Go fills or computes.

type Fields = ViewDescriptor['fields']

const users = { entity: 'users', kind: 'many2one', labelField: 'email' } as const
const company = { entity: 'contact', kind: 'many2one', labelField: 'name', filter: { kind: 'company' } } as const
const project = { entity: 'project', kind: 'many2one', labelField: 'name' } as const
const task = { entity: 'project_task', kind: 'many2one', labelField: 'name' } as const
// A task's stage/milestone/parent: only its own project's rows are offered.
const sameProject = { project_id: 'project_id' }

// ── projects ──────────────────────────────────────────────────────────────────

const visibility: Fields[number] = {
  name: 'visibility',
  label: 'Visibility',
  type: 'selection',
  widget: 'radio',
  selection: { options: ['everyone', 'members'] },
}

const projectListFields: Fields = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'manager_id', label: 'Manager', type: 'relation', relation: users},
  visibility,
  { name: 'task_count', label: 'Tasks', type: 'number', widget: 'int', readOnly: true },
  { name: 'planned_hours', label: 'Planned hours', type: 'number', readOnly: true },
  { name: 'spent_hours', label: 'Spent hours', type: 'number', readOnly: true },
  { name: 'active', label: 'Active', type: 'boolean', widget: 'switch', default: true },
]

const projectFormFields: Fields = [
  ...projectListFields,
  { name: 'company_id', label: 'Company', type: 'relation', relation: company },
  { name: 'date_start', label: 'Start date', type: 'date' },
  { name: 'date_end', label: 'End date', type: 'date' },
  { name: 'description', label: 'Description', type: 'text', widget: 'long' },
  {
    name: 'members',
    label: 'Members',
    type: 'relation',
    relation: { entity: 'users', kind: 'many2many', via: 'project_member', viaFields: { own: 'project_id', related: 'user_id' }, labelField: 'email' },
  },
  {
    name: 'stages',
    label: 'Stages',
    type: 'relation',
    relation: { entity: 'project_stage', kind: 'one2many', inverseField: 'project_id', labelField: 'name' },
    widgetOptions: {
      deletable: true,
      columns: [
        { key: 'sequence', label: 'Sequence' },
        { key: 'closed', label: 'Closed' },
      ],
    },
  },
  {
    name: 'milestones',
    label: 'Milestones',
    type: 'relation',
    relation: { entity: 'project_milestone', kind: 'one2many', inverseField: 'project_id', labelField: 'name', formPath: '/project/milestones/:id' },
    widgetOptions: {
      columns: [
        { key: 'deadline', label: 'Deadline' },
        { key: 'reached', label: 'Reached' },
        { key: 'task_done_count', label: 'Done tasks' },
        { key: 'task_count', label: 'Tasks' },
      ],
    },
  },
]

export const projectPagesOperations: Operation[] = [
  { op: 'addNode', node: { kind: 'page', title: 'Members', children: [{ kind: 'field', name: 'members' }] }, target: FORM_NOTEBOOK_ID, position: 'first' },
  { op: 'addNode', node: { kind: 'page', title: 'Stages', children: [{ kind: 'field', name: 'stages' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
  { op: 'addNode', node: { kind: 'page', title: 'Milestones', children: [{ kind: 'field', name: 'milestones' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
]

/** The project's tasks list, scoped to it — an exact filter, so its board's columns are editable. */
export function projectTasksPath(projectId: string): string {
  return `/project/tasks?filter[project_id]=${encodeURIComponent(projectId)}`
}

registerHeaderButtonAction({
  entity: 'project',
  name: 'project.openTasks',
  handler: async (ctx) => {
    ctx.navigate?.(projectTasksPath(ctx.recordId))
  },
})

// Snapshot the current plan as a baseline (WP3's baseline action). The
// manager/admin gate is Go's can_manage: a header button's `states.visible`
// is a field-only condition (it cannot await), so the guard runs here.
registerHeaderButtonAction({
  entity: 'project',
  name: 'project.saveBaseline',
  handler: async (ctx) => {
    const guard = kanbanColumnsGuard('project.canEditStages')
    if (!guard || !(await guard(ctx.recordId, ctx.relationOps))) return
    // This package type-checks without the DOM lib: prompt is a global.
    const raw = (globalThis as { prompt?: (message?: string) => string | null }).prompt?.(
      translate(useI18nStore.getState().locale, 'Baseline name'),
    )
    const name = raw?.trim()
    if (!name) return
    await ctx.runAction?.('baseline', { body: { name } })
  },
})

const projectHeaderButtons: HeaderButtonDescriptor[] = [
  { name: 'project.openTasks', label: 'Tasks', variant: 'secondary', states: { visible: { field: 'id', op: 'set' } } },
  { name: 'project.saveBaseline', label: 'Save baseline', variant: 'secondary', states: { visible: { field: 'id', op: 'set' } } },
]

// Adding/renaming/reordering a project's stages from its board: Go's
// can_manage (manager or project admin). The id is encoded: it comes from the URL.
registerKanbanColumnsGuard('project.canEditStages', async (projectId, ops) => {
  if (!ops) return false
  const res = await ops.get('project', `${encodeURIComponent(projectId)}/can_manage`)
  return res.can_manage === true
})

// ── tasks ─────────────────────────────────────────────────────────────────────

/** Hours left: planned minus own and subtasks' spent hours (negative = over budget). */
export function remainingHours(draft: Record<string, unknown>): number {
  const n = (k: string) => Number(draft[k] ?? 0) || 0
  return n('planned_hours') - n('spent_hours') - n('subtask_hours')
}

registerFieldFunction({
  entity: 'project_task',
  name: 'project.remainingHours',
  depends: ['planned_hours', 'spent_hours', 'subtask_hours'],
  handler: remainingHours,
})

const stage = { entity: 'project_stage', kind: 'many2one', labelField: 'name' } as const

// The task's order number ("3.1.2"): Go keeps it and moves the task when one is typed.
const orderField: Fields[number] = { name: 'wbs_number', label: 'Order', type: 'text' }

const taskListFields: Fields = [
  orderField,
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'project_id', label: 'Project', type: 'relation', required: true, relation: project },
  { name: 'stage_id', label: 'Stage', type: 'relation', relation: stage },
  { name: 'date_start', label: 'Start date', type: 'date' },
  { name: 'deadline', label: 'Deadline', type: 'date' },
  { name: 'priority', label: 'Priority', type: 'boolean', widget: 'stars' },
  { name: 'planned_hours', label: 'Planned hours', type: 'number' },
  { name: 'spent_hours', label: 'Spent hours', type: 'number', readOnly: true },
  { name: 'blocked', label: 'Blocked', type: 'boolean', readOnly: true },
  // When the task moved into a closed stage (Go's trigger; ADR-041).
  { name: 'closed_at', label: 'Closed at', type: 'date', widget: 'datetime', readOnly: true },
]

const taskViewModeDefaults: ViewDescriptor['viewModeDefaults'] = {
  kanbanStatusField: 'stage_id',
  kanbanColumns: { orderField: 'sequence', labelField: 'name', foldField: 'closed', scopeField: 'project_id', canEdit: 'project.canEditStages' },
  kanbanBadgeField: 'blocked',
  calendarDateField: 'deadline',
  enableGraphs: true,
  ganttStartField: 'date_start',
  ganttEndField: 'deadline',
  ganttDependencies: { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' },
  // The task form's color_groups: colors the Gantt bars and the cards' ribbon.
  colorTagsField: 'color_groups',
  // WBS/PERT diagram modes (ADR-039); PERT dates reuse the Gantt start/end fields.
  wbsParentField: 'parent_id',
  wbsGroupField: 'project_id',
  wbsOrderField: 'wbs_number',
  // WBS deliverables: each task's milestone under it, level-1 ones on a footer row (ADR-039).
  wbsDeliverables: { field: 'milestone_id', entity: 'project_milestone', formPath: '/project/milestones/:id', labelField: 'name', doneField: 'task_done_count', totalField: 'task_count' },
  pertDependencies: { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' },
  pertHoursField: 'planned_hours',
  // OBS chart of the pinned project (ADR-039).
  obs: { entity: 'project_obs_box', projectField: 'project_id', projectEntity: 'project', companyField: 'company_id', canEdit: 'project.canEditStages' },
  // Risk analysis: matrix, Ishikawa and register tabs over these tables.
  risk: { entity: 'project_risk', linkEntity: 'project_risk_task', categoryEntity: 'project_risk_category', projectField: 'project_id', formPath: '/project/risks/:id' },
  // Gantt schedule and baselines of the pinned project (ADR-041).
  ganttSchedule: { scopeField: 'project_id', scopeEntity: 'project', path: 'schedule' },
  ganttBaseline: { entity: 'project_baseline', taskEntity: 'project_baseline_task', scopeField: 'project_id', linkField: 'task_id', startField: 'date_start', endField: 'deadline' },
  // Milestones of the pinned project as diamonds on their deadline.
  ganttMilestones: { entity: 'project_milestone', scopeField: 'project_id', dateField: 'deadline', labelField: 'name', reachedField: 'reached', formPath: '/project/milestones/:id' },
  // Kanban swimlanes: one lane per assignee, over the task's assignees junction.
  kanbanSwimlanes: { label: 'Assignee', via: 'project_task_user', ownField: 'task_id', relatedField: 'user_id', entity: 'users', labelField: 'email' },
  // Insights and Matrices modes over the pinned project (ADR-041); the DSM
  // reuses the pert dependencies.
  insights: { projectField: 'project_id', projectEntity: 'project', metricsPath: 'metrics', milestoneEntity: 'project_milestone' },
  matrix: {
    projectField: 'project_id',
    raciEntity: 'project_task_raci',
    userLabelField: 'email',
    dependencies: { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' },
    priorityField: 'priority',
    deadlineField: 'deadline',
    closedField: 'closed',
    urgentDays: 7,
    taskEntity: 'project_task',
    taskFormPath: '/project/tasks/:id',
  },
  // PBS diagram mode over the pinned project: its deliverables (ADR-039).
  pbs: { entity: 'project_pbs_item', projectField: 'project_id', projectEntity: 'project', taskField: 'pbs_item_id', canEdit: 'project.canEditStages' },
}

// The task's many2many fields: on the form, and filters of the task lists
// (Go's TaskFilters resolves filter[assignees]/filter[color_groups]).
const assigneesField: Fields[number] = {
  name: 'assignees',
  label: 'Assignees',
  type: 'relation',
  relation: { entity: 'users', kind: 'many2many', via: 'project_task_user', viaFields: { own: 'task_id', related: 'user_id' }, labelField: 'email' },
}
const colorGroupsField: Fields[number] = {
  name: 'color_groups',
  label: 'Color groups',
  type: 'relation',
  widget: 'colortags',
  relation: { entity: 'project_color', kind: 'many2many', via: 'project_task_color', viaFields: { own: 'task_id', related: 'color_id' }, labelField: 'name' },
}
// The task's deliverable (PBS, ADR-039): on the form, and a filter of the task
// lists (Go's TaskFilters resolves filter[pbs_item_id]).
const deliverableField: Fields[number] = {
  name: 'pbs_item_id',
  label: 'Deliverable',
  type: 'relation',
  relation: { entity: 'project_pbs_item', kind: 'many2one', labelField: 'name', filterFields: sameProject },
}

const taskFormFields: Fields = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'project_id', label: 'Project', type: 'relation', required: true, relation: project },
  orderField,
  { name: 'stage_id', label: 'Stage', type: 'relation', relation: { ...stage, filterFields: sameProject } },
  { name: 'parent_id', label: 'Parent task', type: 'relation', relation: { ...task, filterFields: sameProject } },
  {
    name: 'milestone_id',
    label: 'Milestone',
    type: 'relation',
    relation: { entity: 'project_milestone', kind: 'many2one', labelField: 'name', filterFields: sameProject },
  },
  assigneesField,
  {
    name: 'tags',
    label: 'Tags',
    type: 'relation',
    relation: { entity: 'project_tag', kind: 'many2many', via: 'project_task_tag', viaFields: { own: 'task_id', related: 'tag_id' }, labelField: 'name' },
  },
  colorGroupsField,
  { name: 'date_start', label: 'Start date', type: 'date' },
  { name: 'deadline', label: 'Deadline', type: 'date' },
  { name: 'priority', label: 'Priority', type: 'boolean', widget: 'stars' },
  { name: 'planned_hours', label: 'Planned hours', type: 'number' },
  { name: 'spent_hours', label: 'Spent hours', type: 'number', readOnly: true },
  { name: 'subtask_hours', label: 'Subtask hours', type: 'number', readOnly: true },
  { name: 'remaining_hours', label: 'Remaining hours', type: 'number', store: false, compute: 'project.remainingHours' },
  { name: 'subtask_done_count', label: 'Done subtasks', type: 'number', widget: 'int', readOnly: true },
  { name: 'subtask_count', label: 'Subtasks', type: 'number', widget: 'int', readOnly: true },
  { name: 'blocked', label: 'Blocked', type: 'boolean', readOnly: true },
  { name: 'description', label: 'Description', type: 'text', widget: 'long' },
  {
    name: 'subtasks',
    label: 'Subtasks',
    type: 'relation',
    relation: { entity: 'project_task', kind: 'one2many', inverseField: 'parent_id', labelField: 'name', formPath: '/project/tasks/:id' },
    widgetOptions: {
      columns: [
        { key: 'deadline', label: 'Deadline' },
        { key: 'planned_hours', label: 'Planned hours' },
        { key: 'spent_hours', label: 'Spent hours' },
        { key: 'closed', label: 'Done' },
      ],
    },
  },
  // Dependencies as task tags over the junction (names, not ids): Blocked by
  // writes project_task_dependency rows; Blocking is its read-only inverse.
  {
    name: 'blocked_by',
    label: 'Blocked by',
    type: 'relation',
    relation: { entity: 'project_task', kind: 'many2many', via: 'project_task_dependency', viaFields: { own: 'task_id', related: 'depends_on_id' }, labelField: 'name' },
  },
  {
    name: 'blocking',
    label: 'Blocking',
    type: 'relation',
    readOnly: true,
    relation: { entity: 'project_task', kind: 'many2many', via: 'project_task_dependency', viaFields: { own: 'depends_on_id', related: 'task_id' }, labelField: 'name' },
  },
  {
    name: 'timesheets',
    label: 'Timesheets',
    type: 'relation',
    relation: { entity: 'project_timesheet', kind: 'one2many', inverseField: 'task_id', labelField: 'date' },
    // Date leads (labelField); the user column shows the raw id, like every o2m many2one cell.
    widgetOptions: {
      deletable: true,
      columns: [
        { key: 'user_id', label: 'User' },
        { key: 'hours', label: 'Hours' },
        { key: 'description', label: 'Description' },
      ],
    },
  },
  // When the task moved into a closed stage (Go's trigger; ADR-041).
  { name: 'closed_at', label: 'Closed at', type: 'date', widget: 'datetime', readOnly: true },
  // The task's RACI rows (Matrices mode, ADR-041): who is Responsible /
  // Accountable / Consulted / Informed. No quick-create — the child entity
  // has no registered form of its own.
  {
    name: 'raci',
    label: 'RACI',
    type: 'relation',
    relation: { entity: 'project_task_raci', kind: 'one2many', inverseField: 'task_id', labelField: 'user_id' },
    widgetOptions: {
      deletable: true,
      columns: [
        { key: 'user_id', label: 'User' },
        { key: 'role', label: 'Role' },
      ],
    },
  },
  deliverableField,
]

// Description first, then the task's links; the synthesized Settings page
// (now empty) keeps hosting the record's own runtime pages.
export const taskPagesOperations: Operation[] = [
  { op: 'addNode', node: { kind: 'page', title: 'Description', children: [{ kind: 'field', name: 'description' }] }, target: FORM_NOTEBOOK_ID, position: 'first' },
  { op: 'addNode', node: { kind: 'page', title: 'Subtasks', children: [{ kind: 'field', name: 'subtasks' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
  { op: 'addNode', node: { kind: 'page', title: 'Blocked by', children: [{ kind: 'field', name: 'blocked_by' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
  { op: 'addNode', node: { kind: 'page', title: 'Blocking', children: [{ kind: 'field', name: 'blocking' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
  { op: 'addNode', node: { kind: 'page', title: 'Timesheets', children: [{ kind: 'field', name: 'timesheets' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
  { op: 'addNode', node: { kind: 'page', title: 'RACI', children: [{ kind: 'field', name: 'raci' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
]

// ── milestones, timesheets, stages, tags ─────────────────────────────────────

const milestoneListFields: Fields = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'project_id', label: 'Project', type: 'relation', required: true, relation: project },
  { name: 'deadline', label: 'Deadline', type: 'date' },
  { name: 'reached', label: 'Reached', type: 'boolean', widget: 'switch' },
  { name: 'task_done_count', label: 'Done tasks', type: 'number', widget: 'int', readOnly: true },
  { name: 'task_count', label: 'Tasks', type: 'number', widget: 'int', readOnly: true },
]

const milestoneFormFields: Fields = [
  ...milestoneListFields,
  { name: 'reached_at', label: 'Reached on', type: 'date', widget: 'datetime', readOnly: true },
  {
    name: 'tasks',
    label: 'Tasks',
    type: 'relation',
    relation: { entity: 'project_task', kind: 'one2many', inverseField: 'milestone_id', labelField: 'name', formPath: '/project/tasks/:id' },
    widgetOptions: {
      columns: [
        { key: 'deadline', label: 'Deadline' },
        { key: 'closed', label: 'Done' },
      ],
    },
  },
]

const timesheetFields: Fields = [
  { name: 'date', label: 'Date', type: 'date', required: true },
  { name: 'user_id', label: 'User', type: 'relation', relation: users },
  { name: 'project_id', label: 'Project', type: 'relation', readOnly: true, relation: project },
  { name: 'task_id', label: 'Task', type: 'relation', required: true, relation: task },
  { name: 'hours', label: 'Hours', type: 'number', required: true },
  { name: 'description', label: 'Description', type: 'text' },
]

const stageFields: Fields = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'project_id', label: 'Project', type: 'relation', required: true, relation: project },
  { name: 'sequence', label: 'Sequence', type: 'number', widget: 'int' },
  { name: 'closed', label: 'Closed', type: 'boolean', widget: 'switch' },
]

const tagFields: Fields = [{ name: 'name', label: 'Name', type: 'text', required: true }]

const colorFields: Fields = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'color', label: 'Color', type: 'text', widget: 'color', required: true },
]

// ── risks ─────────────────────────────────────────────────────────────────────
// The scores are integer columns while `selection` options are strings, so they are
// number fields whose labels carry the legend words (spreadsheet legend).

const riskCategory = { entity: 'project_risk_category', kind: 'many2one', labelField: 'name' } as const
const riskImpact: Fields[number] = { name: 'impact_on', label: 'Impact on', type: 'selection', widget: 'radio', selection: { options: ['delay', 'cost', 'quality'] } }
const likelihood = 'Likelihood (1 unlikely, 2 likely, 3 very likely)'
const detectability = 'Detectability (1 easy, 2 difficult, 3 impossible)'

const riskListFields: Fields = [
  { name: 'name', label: 'Risk', type: 'text', required: true },
  { name: 'project_id', label: 'Project', type: 'relation', required: true, relation: project },
  { name: 'category_id', label: 'Risk category', type: 'relation', relation: riskCategory },
  riskImpact,
  { name: 'likelihood', label: likelihood, type: 'number', widget: 'int' },
  { name: 'detectability', label: detectability, type: 'number', widget: 'int' },
  { name: 'severity_effective', label: 'Severity', type: 'number', widget: 'int', readOnly: true },
  { name: 'criticity', label: 'Criticity', type: 'number', widget: 'int', readOnly: true },
  { name: 'residual_criticity', label: 'Residual criticity', type: 'number', widget: 'int', readOnly: true },
  { name: 'responsible_id', label: 'Responsible', type: 'relation', relation: users },
  { name: 'deadline', label: 'Deadline', type: 'date' },
]

const riskFormFields: Fields = [
  riskListFields[0],
  // The read-only mind map: a virtual anchor centred on the (editable) name, so every input stays in the layout once.
  {
    name: 'risk_map',
    label: 'Risk map',
    type: 'text',
    widget: 'mindmap',
    store: false,
    readOnly: true,
    hideLabel: true,
    widgetOptions: {
      center: 'name',
      satellites: [
        { field: 'category_id', label: 'Risk category', entity: 'project_risk_category' },
        { field: 'description', label: 'Risk type' },
        { field: 'phase_task_id', label: 'Project phase', entity: 'project_task' },
      ],
    },
  },
  // The project is chosen at creation only: Go refuses to move a risk.
  { ...riskListFields[1], states: { readOnly: { field: 'id', op: 'set' } } },
  riskListFields[2],
  { name: 'description', label: 'Risk type', type: 'text' },
  // Top-level tasks of the same project; Go's 422 guards the top-level part (a relation filter can't express "no parent").
  { name: 'phase_task_id', label: 'Project phase', type: 'relation', relation: { ...task, filterFields: sameProject } },
  riskImpact,
  { name: 'likelihood', label: likelihood, type: 'number', widget: 'int' },
  { name: 'detectability', label: detectability, type: 'number', widget: 'int' },
  { name: 'severity_computed', label: 'Computed severity', type: 'number', widget: 'int', readOnly: true },
  {
    name: 'severity_note',
    label: 'Computation note',
    type: 'selection',
    readOnly: true,
    selection: { options: ['no_estimate', 'cycle', 'no_planned_hours'], labels: { no_estimate: 'No estimate on linked tasks', cycle: 'Dependency cycle', no_planned_hours: 'Project has no planned hours' } },
  },
  { name: 'severity', label: 'Severity (1 to 4, overrides the computed one)', type: 'number', widget: 'int' },
  { name: 'criticity', label: 'Criticity', type: 'number', widget: 'int', readOnly: true },
  { name: 'remediation', label: 'Remediation', type: 'text', widget: 'long' },
  { name: 'if_it_happens', label: 'If it happens', type: 'text', widget: 'long' },
  { name: 'residual_likelihood', label: 'Residual likelihood (1 to 3)', type: 'number', widget: 'int' },
  { name: 'residual_detectability', label: 'Residual detectability (1 to 3)', type: 'number', widget: 'int' },
  { name: 'residual_severity', label: 'Residual severity (1 to 4)', type: 'number', widget: 'int' },
  { name: 'residual_criticity', label: 'Residual criticity', type: 'number', widget: 'int', readOnly: true },
  { name: 'responsible_id', label: 'Responsible', type: 'relation', relation: users },
  { name: 'deadline', label: 'Deadline', type: 'date' },
  {
    name: 'linked_tasks',
    label: 'Linked tasks',
    type: 'relation',
    // Known v1 limit: the grid shows the raw task id (it has no child descriptor to resolve many2one labels with) and the dialog's task picker isn't scoped to the risk's project (Go's 422 guards that); see ADR-040 Pitfalls.
    relation: { entity: 'project_risk_task', kind: 'one2many', inverseField: 'risk_id', labelField: 'task_id' },
    widgetOptions: {
      deletable: true,
      columns: [
        { key: 'delay_days', label: 'Delay (days)' },
        { key: 'extra_hours', label: 'Extra hours' },
      ],
    },
  },
]

const f = (name: string) => ({ kind: 'field' as const, name })
const riskFormLayout: ViewDescriptor['layout'] = [
  { kind: 'row', id: FORM_HEADER_ID, children: [{ kind: 'field', name: 'name', variant: 'title' }] },
  { kind: 'group', children: [f('risk_map')] },
  { kind: 'group', columns: 2, children: ['project_id', 'category_id', 'description', 'phase_task_id'].map(f) },
  {
    kind: 'group',
    id: FORM_COLUMNS_ID,
    columns: 2,
    children: [
      { kind: 'group', title: 'Assessment', children: ['impact_on', 'likelihood', 'detectability', 'severity_computed', 'severity_note', 'severity', 'criticity'].map(f) },
      {
        kind: 'group',
        title: 'Remediation',
        children: ['remediation', 'if_it_happens', 'residual_likelihood', 'residual_detectability', 'residual_severity', 'residual_criticity', 'responsible_id', 'deadline'].map(f),
      },
    ],
  },
  {
    kind: 'notebook',
    id: FORM_NOTEBOOK_ID,
    children: [{ kind: 'page', title: 'Linked tasks', children: [f('linked_tasks')] }],
  },
]

// The linked-task dialog: pick the task, then the estimate that matches the risk's impact.
const riskTaskFields: Fields = [
  { name: 'task_id', label: 'Task', type: 'relation', required: true, relation: task },
  { name: 'delay_days', label: 'Delay (days)', type: 'number' },
  { name: 'extra_hours', label: 'Extra hours', type: 'number' },
]

const riskCategoryFields: Fields = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'color', label: 'Color', type: 'text', widget: 'color' },
]

// Weekly capacities (WP10): one row per user, the Workload heatmap compares a
// user's planned load against it (default 40 h/week when the row is missing).
const capacityFields: Fields = [
  { name: 'user_id', label: 'User', type: 'relation', relation: users, required: true },
  { name: 'hours_per_week', label: 'Hours per week', type: 'number', required: true },
]

// Color groups are renamed, recolored and deleted from the Configuration menu.
registerHeaderMenu('project', 'configuration', {
  entries: [
    { kind: 'line', label: 'Color groups', path: '/project/colors', permission: 'project_color:project_color:read' },
    { kind: 'line', label: 'Risk categories', path: '/project/risk_categories', permission: 'project_risk_category:project_risk_category:read' },
    { kind: 'line', label: 'Capacities', path: '/project/capacities', permission: 'project_capacity:project_capacity:read' },
  ],
})

// The cross-project planning pages (My day, Timesheet week, Workload,
// Portfolio): their own shell pages, reached from one Planning menu instead of
// four more top-bar entries.
registerHeaderMenu('project', 'planning', {
  label: 'Planning',
  entries: [
    { kind: 'line', label: 'My day', path: '/project/my-day', permission: 'project_task:project_task:read' },
    { kind: 'line', label: 'Timesheet week', path: '/project/timesheet-week', permission: 'project_timesheet:project_timesheet:read' },
    { kind: 'line', label: 'Workload', path: '/project/workload', permission: 'project_task:project_task:read' },
    { kind: 'line', label: 'Portfolio', path: '/project/portfolio', permission: 'project:project:read' },
  ],
})

// ── routes ────────────────────────────────────────────────────────────────────

const perm = (table: string) => [`${table}:${table}:read`]
const write = (table: string) => `${table}:${table}:write`

const tasksList = (navLabel: string, listFilter?: ViewDescriptor['listFilter']): ViewDescriptor => ({
  entity: 'project_task',
  viewType: 'tree',
  navLabel,
  fields: taskListFields,
  formPath: '/project/tasks/:id',
  createPermission: write('project_task'),
  permissions: perm('project_task'),
  viewModeDefaults: taskViewModeDefaults,
  search: { filterOnlyFields: [assigneesField, colorGroupsField, deliverableField] },
  ...(listFilter ? { listFilter } : {}),
})

// The route's own permission gates the app tile and menu lines, so each route
// carries its entity's read. Stage/tag/timesheet forms back the relation
// widgets' create and edit wizards.
const routes: FrontModule['routes'] = [
  {
    path: '/project',
    descriptor: {
      entity: 'project',
      viewType: 'tree',
      navLabel: 'Projects',
      // Archived projects are hidden by default, as a filter the user can remove.
      navQuery: '?filter[active]=true',
      fields: projectListFields,
      formPath: '/project/:id',
      createPermission: write('project'),
      permissions: perm('project'),
      viewModeDefaults: { kanbanStatusField: 'visibility' },
    },
  },
  {
    path: '/project/:id',
    descriptor: { entity: 'project', viewType: 'form', fields: projectFormFields, headerButtons: projectHeaderButtons, permissions: perm('project') },
  },
  { path: '/project/tasks', descriptor: tasksList('Tasks') },
  // Go narrows filter[assignee]=me to the caller's assigned tasks (AssignedToMe).
  { path: '/project/my-tasks', descriptor: tasksList('My tasks', { filter: { assignee: 'me' } }) },
  {
    path: '/project/tasks/:id',
    descriptor: { entity: 'project_task', viewType: 'form', fields: taskFormFields, permissions: perm('project_task') },
  },
  {
    path: '/project/milestones',
    descriptor: {
      entity: 'project_milestone',
      viewType: 'tree',
      navLabel: 'Milestones',
      fields: milestoneListFields,
      formPath: '/project/milestones/:id',
      createPermission: write('project_milestone'),
      permissions: perm('project_milestone'),
    },
  },
  {
    path: '/project/milestones/:id',
    descriptor: { entity: 'project_milestone', viewType: 'form', fields: milestoneFormFields, permissions: perm('project_milestone') },
  },
  {
    path: '/project/timesheets',
    descriptor: {
      entity: 'project_timesheet',
      viewType: 'tree',
      navLabel: 'Timesheets',
      fields: timesheetFields,
      formPath: '/project/timesheets/:id',
      createPermission: write('project_timesheet'),
      permissions: perm('project_timesheet'),
      viewModeDefaults: { calendarDateField: 'date', enableGraphs: true },
    },
  },
  {
    path: '/project/timesheets/:id',
    descriptor: { entity: 'project_timesheet', viewType: 'form', fields: timesheetFields, permissions: perm('project_timesheet') },
  },
  {
    path: '/project/stages/:id',
    descriptor: { entity: 'project_stage', viewType: 'form', fields: stageFields, permissions: perm('project_stage') },
  },
  {
    path: '/project/colors',
    descriptor: {
      entity: 'project_color',
      viewType: 'tree',
      navLabel: 'Color groups',
      hideFromTopBar: true,
      fields: colorFields,
      formPath: '/project/colors/:id',
      createPermission: write('project_color'),
      permissions: perm('project_color'),
    },
  },
  {
    path: '/project/colors/:id',
    descriptor: { entity: 'project_color', viewType: 'form', fields: colorFields, permissions: perm('project_color') },
  },
  {
    path: '/project/risks',
    descriptor: {
      entity: 'project_risk',
      viewType: 'tree',
      navLabel: 'Risks',
      fields: riskListFields,
      formPath: '/project/risks/:id',
      createPermission: write('project_risk'),
      permissions: perm('project_risk'),
      viewModeDefaults: { enableGraphs: true },
    },
  },
  {
    path: '/project/risks/:id',
    descriptor: { entity: 'project_risk', viewType: 'form', fields: riskFormFields, layout: riskFormLayout, permissions: perm('project_risk') },
  },
  {
    path: '/project/risk_tasks/:id',
    descriptor: { entity: 'project_risk_task', viewType: 'form', fields: riskTaskFields, permissions: perm('project_risk_task') },
  },
  {
    path: '/project/risk_categories',
    descriptor: {
      entity: 'project_risk_category',
      viewType: 'tree',
      navLabel: 'Risk categories',
      hideFromTopBar: true,
      fields: riskCategoryFields,
      formPath: '/project/risk_categories/:id',
      createPermission: write('project_risk_category'),
      permissions: perm('project_risk_category'),
    },
  },
  {
    path: '/project/risk_categories/:id',
    descriptor: { entity: 'project_risk_category', viewType: 'form', fields: riskCategoryFields, permissions: perm('project_risk_category') },
  },
  {
    path: '/project/tags/:id',
    descriptor: { entity: 'project_tag', viewType: 'form', fields: tagFields, permissions: perm('project_tag') },
  },
  // The planning pages (ADR-041): shell pages with their own rendering. These
  // routes only gate them (permission per page) and keep the top bar on the
  // Project's own menus — dashboard + hideFromTopBar, Teams' trick.
  {
    path: '/project/my-day',
    descriptor: { entity: 'project_task', viewType: 'dashboard', fields: [], hideFromTopBar: true, permissions: perm('project_task') },
  },
  {
    path: '/project/timesheet-week',
    descriptor: { entity: 'project_timesheet', viewType: 'dashboard', fields: [], hideFromTopBar: true, permissions: perm('project_timesheet') },
  },
  {
    path: '/project/workload',
    descriptor: { entity: 'project_task', viewType: 'dashboard', fields: [], hideFromTopBar: true, permissions: perm('project_task') },
  },
  {
    path: '/project/portfolio',
    descriptor: { entity: 'project', viewType: 'dashboard', fields: [], hideFromTopBar: true, permissions: perm('project') },
  },
  // Weekly capacities, edited from the Configuration menu (no top-bar entry).
  {
    path: '/project/capacities',
    descriptor: {
      entity: 'project_capacity',
      viewType: 'tree',
      navLabel: 'Capacities',
      hideFromTopBar: true,
      fields: capacityFields,
      formPath: '/project/capacities/:id',
      createPermission: write('project_capacity'),
      permissions: perm('project_capacity'),
    },
  },
  {
    path: '/project/capacities/:id',
    descriptor: { entity: 'project_capacity', viewType: 'form', fields: capacityFields, permissions: perm('project_capacity') },
  },
]

const projectModule: FrontModule = {
  name: 'project',
  routes: routes.map((r) => ({ ...r, permission: r.descriptor.permissions?.[0] })),
  extends: [
    { path: '/project/:id', operations: projectPagesOperations },
    { path: '/project/tasks/:id', operations: taskPagesOperations },
  ],
}

export default projectModule
