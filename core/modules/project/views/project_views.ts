import {
  FORM_NOTEBOOK_ID,
  registerFieldFunction,
  registerHeaderButtonAction,
  registerHeaderMenu,
  registerKanbanColumnsGuard,
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
  { name: 'manager_id', label: 'Manager', type: 'relation', relation: users },
  visibility,
  { name: 'task_count', label: 'Tasks', type: 'number', widget: 'int', readOnly: true },
  { name: 'planned_hours', label: 'Planned hours', type: 'number', readOnly: true },
  { name: 'spent_hours', label: 'Spent hours', type: 'number', readOnly: true },
  { name: 'active', label: 'Active', type: 'boolean', widget: 'switch', default: true },
]

const projectFormFields: Fields = [
  ...projectListFields,
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

const projectHeaderButtons: HeaderButtonDescriptor[] = [
  { name: 'project.openTasks', label: 'Tasks', variant: 'secondary', states: { visible: { field: 'id', op: 'set' } } },
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
  pertDependencies: { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' },
  pertHoursField: 'planned_hours',
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
]

// Description first, then the task's links; the synthesized Settings page
// (now empty) keeps hosting the record's own runtime pages.
export const taskPagesOperations: Operation[] = [
  { op: 'addNode', node: { kind: 'page', title: 'Description', children: [{ kind: 'field', name: 'description' }] }, target: FORM_NOTEBOOK_ID, position: 'first' },
  { op: 'addNode', node: { kind: 'page', title: 'Subtasks', children: [{ kind: 'field', name: 'subtasks' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
  { op: 'addNode', node: { kind: 'page', title: 'Blocked by', children: [{ kind: 'field', name: 'blocked_by' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
  { op: 'addNode', node: { kind: 'page', title: 'Blocking', children: [{ kind: 'field', name: 'blocking' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
  { op: 'addNode', node: { kind: 'page', title: 'Timesheets', children: [{ kind: 'field', name: 'timesheets' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
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

// Color groups are renamed, recolored and deleted from the Configuration menu.
registerHeaderMenu('project', 'configuration', {
  entries: [{ kind: 'line', label: 'Color groups', path: '/project/colors', permission: 'project_color:project_color:read' }],
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
  search: { filterOnlyFields: [assigneesField, colorGroupsField] },
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
    path: '/project/tags/:id',
    descriptor: { entity: 'project_tag', viewType: 'form', fields: tagFields, permissions: perm('project_tag') },
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
