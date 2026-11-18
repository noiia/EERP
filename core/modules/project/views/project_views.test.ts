import { describe, expect, it, vi } from 'vitest'
import { behaviorRegistry, headerButtonRegistry, kanbanColumnsGuard, ModuleRegistry } from '@eerp/core-front'
import mod, { projectTasksPath, remainingHours } from './project_views'

const route = (path: string) => mod.routes.find((r) => r.path === path)!
const field = (path: string, name: string) => route(path).descriptor.fields.find((f) => f.name === name)!

describe('project views', () => {
  it('offers only company contacts as the project company', () => {
    expect(field('/project/:id', 'company_id').relation).toMatchObject({ entity: 'contact', kind: 'many2one', filter: { kind: 'company' } })
  })

  it('registers a Project app with every route and its permission', () => {
    const registry = new ModuleRegistry()
    registry.register(mod, { appMode: true }) // throws on an invalid descriptor or extension
    const expected: [string, string, string][] = [
      ['/project', 'tree', 'project'],
      ['/project/:id', 'form', 'project'],
      ['/project/tasks', 'tree', 'project_task'],
      ['/project/my-tasks', 'tree', 'project_task'],
      ['/project/tasks/:id', 'form', 'project_task'],
      ['/project/milestones', 'tree', 'project_milestone'],
      ['/project/milestones/:id', 'form', 'project_milestone'],
      ['/project/timesheets', 'tree', 'project_timesheet'],
    ]
    for (const [path, viewType, table] of expected) {
      const r = route(path)
      expect(r.descriptor.viewType, path).toBe(viewType)
      expect(r.descriptor.entity, path).toBe(table)
      expect(r.permission, path).toBe(`${table}:${table}:read`)
    }
    const menus = registry.headerMenus().find((m) => m.module === 'project')!.menus
    expect(menus.map((m) => m.label)).toEqual(['Projects', 'Tasks', 'My tasks', 'Milestones', 'Timesheets', 'Risks', 'Planning', 'Configuration'])
    // Archived projects are hidden by a removable default filter, not a fixed listFilter.
    expect(menus[0].entries[0]).toMatchObject({ path: '/project?filter[active]=true' })
    expect(route('/project').descriptor.listFilter).toBeUndefined()
    expect(route('/project').descriptor.fields.map((f) => f.name)).toContain('active')
  })

  it('boards tasks by their project stages, kanban/calendar/graph on', () => {
    const expected = {
      kanbanStatusField: 'stage_id',
      kanbanColumns: { orderField: 'sequence', labelField: 'name', foldField: 'closed', scopeField: 'project_id', canEdit: 'project.canEditStages' },
      kanbanBadgeField: 'blocked',
      calendarDateField: 'deadline',
      enableGraphs: true,
      ganttStartField: 'date_start',
      ganttEndField: 'deadline',
      ganttDependencies: { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' },
      colorTagsField: 'color_groups',
      wbsParentField: 'parent_id',
      wbsGroupField: 'project_id',
      wbsOrderField: 'wbs_number',
      wbsDeliverables: { field: 'milestone_id', entity: 'project_milestone', formPath: '/project/milestones/:id', labelField: 'name', doneField: 'task_done_count', totalField: 'task_count' },
      pertDependencies: { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' },
      pertHoursField: 'planned_hours',
      obs: { entity: 'project_obs_box', projectField: 'project_id', projectEntity: 'project', companyField: 'company_id', canEdit: 'project.canEditStages' },
      risk: { entity: 'project_risk', linkEntity: 'project_risk_task', categoryEntity: 'project_risk_category', projectField: 'project_id', formPath: '/project/risks/:id' },
      ganttSchedule: { scopeField: 'project_id', scopeEntity: 'project', path: 'schedule' },
      ganttBaseline: { entity: 'project_baseline', taskEntity: 'project_baseline_task', scopeField: 'project_id', linkField: 'task_id', startField: 'date_start', endField: 'deadline' },
      ganttMilestones: { entity: 'project_milestone', scopeField: 'project_id', dateField: 'deadline', labelField: 'name', reachedField: 'reached', formPath: '/project/milestones/:id' },
      kanbanSwimlanes: { label: 'Assignee', via: 'project_task_user', ownField: 'task_id', relatedField: 'user_id', entity: 'users', labelField: 'email' },
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
      pbs: { entity: 'project_pbs_item', projectField: 'project_id', projectEntity: 'project', taskField: 'pbs_item_id', canEdit: 'project.canEditStages' },
    }
    expect(route('/project/tasks').descriptor.viewModeDefaults).toEqual(expected)
    expect(route('/project/my-tasks').descriptor.viewModeDefaults).toEqual(expected)
    expect(route('/project/my-tasks').descriptor.listFilter).toEqual({ filter: { assignee: 'me' } })
    expect(route('/project').descriptor.viewModeDefaults).toEqual({ kanbanStatusField: 'visibility' })
    expect(route('/project/timesheets').descriptor.viewModeDefaults?.enableGraphs).toBe(true)
    expect(field('/project/tasks', 'priority')).toMatchObject({ type: 'boolean', widget: 'stars' })
    for (const path of ['/project/tasks', '/project/tasks/:id']) {
      expect(field(path, 'date_start'), path).toMatchObject({ type: 'date', label: 'Start date' })
    }
  })

  it('gives the task form its six notebook pages', () => {
    const registry = new ModuleRegistry()
    registry.register(mod, { appMode: true })
    const notebook = JSON.stringify(registry.formDescriptorFor('project_task')!.layout)
    for (const title of ['Description', 'Subtasks', 'Blocked by', 'Blocking', 'Timesheets', 'RACI']) {
      expect(notebook).toContain(`"title":"${title}"`)
    }
    const raci = field('/project/tasks/:id', 'raci')
    expect(raci.relation).toMatchObject({ entity: 'project_task_raci', kind: 'one2many', inverseField: 'task_id', labelField: 'user_id' })
    expect((raci.widgetOptions!.columns as { key: string }[]).map((c) => c.key)).toEqual(['user_id', 'role'])
    expect(field('/project/tasks/:id', 'subtasks').relation).toMatchObject({ kind: 'one2many', inverseField: 'parent_id' })
    const timesheets = field('/project/tasks/:id', 'timesheets')
    expect(timesheets.relation).toMatchObject({ kind: 'one2many', inverseField: 'task_id', labelField: 'date' })
    expect((timesheets.widgetOptions!.columns as { key: string }[]).map((c) => c.key)).toEqual(['user_id', 'hours', 'description'])
    expect(field('/project/tasks/:id', 'blocked_by').relation).toMatchObject({ via: 'project_task_dependency', viaFields: { own: 'task_id', related: 'depends_on_id' } })
    expect(field('/project/tasks/:id', 'blocking')).toMatchObject({ readOnly: true, relation: { viaFields: { own: 'depends_on_id', related: 'task_id' } } })
  })

  it('scopes stage, milestone and parent to the task\'s project', () => {
    for (const name of ['stage_id', 'milestone_id', 'parent_id', 'pbs_item_id']) {
      expect(field('/project/tasks/:id', name).relation?.filterFields, name).toEqual({ project_id: 'project_id' })
    }
  })

  it('computes remaining hours as planned - spent - subtask, negative when over', () => {
    expect(remainingHours({ planned_hours: 10, spent_hours: 3, subtask_hours: 2 })).toBe(5)
    expect(remainingHours({ planned_hours: 2, spent_hours: 3, subtask_hours: 1 })).toBe(-2)
    expect(remainingHours({})).toBe(0)
    expect(behaviorRegistry.fieldFunction('project.remainingHours')?.depends).toEqual(['planned_hours', 'spent_hours', 'subtask_hours'])
    expect(field('/project/tasks/:id', 'remaining_hours')).toMatchObject({ compute: 'project.remainingHours', store: false })
  })

  it('opens the project\'s tasks with an exact project filter', async () => {
    expect(projectTasksPath('p1')).toBe('/project/tasks?filter[project_id]=p1')
    const navigate = vi.fn()
    await headerButtonRegistry.get('project.openTasks')!.handler({ entity: 'project', recordId: 'p1', draft: {}, setFieldAndCommit: vi.fn(), relationOps: null, navigate })
    expect(navigate).toHaveBeenCalledWith('/project/tasks?filter[project_id]=p1')
  })

  it('lets only can_manage callers edit the board\'s stages', async () => {
    const guard = kanbanColumnsGuard('project.canEditStages')!
    const ops = (can: boolean) => ({ list: vi.fn(), get: vi.fn(async () => ({ id: '', can_manage: can })), create: vi.fn(), remove: vi.fn() })
    const yes = ops(true)
    expect(await guard('p/1', yes)).toBe(true)
    expect(yes.get).toHaveBeenCalledWith('project', 'p%2F1/can_manage')
    expect(await guard('p1', ops(false))).toBe(false)
    expect(await guard('p1', null)).toBe(false)
  })

  it('saves a baseline from the project form header, manager/admin only', async () => {
    // The descriptor offers the button on a saved project record.
    const headerButtons = route('/project/:id').descriptor.headerButtons ?? []
    expect(headerButtons.map((b) => b.name)).toContain('project.saveBaseline')
    expect(headerButtons.find((b) => b.name === 'project.saveBaseline')?.label).toBe('Save baseline')

    const handler = headerButtonRegistry.get('project.saveBaseline')!
    // This package's vitest runs in node (no DOM): stub the prompt on globalThis.
    const prompt = vi.fn<(message?: string) => string | null>(() => 'Baseline A')
    ;(globalThis as { prompt?: unknown }).prompt = prompt
    const runAction = vi.fn(async () => ({}))
    const ctx = (can: boolean) => ({
      entity: 'project',
      recordId: 'p1',
      draft: {},
      setFieldAndCommit: vi.fn(),
      relationOps: { list: vi.fn(), get: vi.fn(async () => ({ id: 'p1/can_manage', can_manage: can })), create: vi.fn(), remove: vi.fn() },
      runAction,
    })
    // Manager: prompts for a name, then runs the baseline action.
    await handler.handler(ctx(true))
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(runAction).toHaveBeenCalledWith('baseline', { body: { name: 'Baseline A' } })

    // Not a manager (can_manage false): no prompt, no action.
    const runAction2 = vi.fn(async () => ({}))
    await handler.handler({ ...ctx(false), runAction: runAction2 })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(runAction2).not.toHaveBeenCalled()

    // A cancelled prompt (null) writes nothing.
    prompt.mockReturnValueOnce(null)
    await handler.handler(ctx(true))
    expect(runAction).toHaveBeenCalledTimes(1)
  })

  it('puts tasks in color groups, managed from the Configuration menu', () => {
    const registry = new ModuleRegistry()
    registry.register(mod, { appMode: true })
    expect(field('/project/tasks/:id', 'color_groups')).toMatchObject({
      widget: 'colortags',
      relation: { entity: 'project_color', kind: 'many2many', via: 'project_task_color', viaFields: { own: 'task_id', related: 'color_id' }, labelField: 'name' },
    })
    // The lists color by it through the form's field (lists show no relation column).
    expect(route('/project/tasks').descriptor.fields.map((f) => f.name)).not.toContain('color_groups')
    expect(field('/project/colors', 'color')).toMatchObject({ type: 'text', widget: 'color', required: true })
    expect(route('/project/colors').descriptor).toMatchObject({ entity: 'project_color', viewType: 'tree', hideFromTopBar: true, formPath: '/project/colors/:id' })
    expect(route('/project/colors/:id').descriptor).toMatchObject({ entity: 'project_color', viewType: 'form' })
    const menus = registry.headerMenus().find((m) => m.module === 'project')!.menus
    expect(menus.map((m) => m.label)).not.toContain('Color groups')
    const config = menus.find((m) => m.label === 'Configuration')!
    expect(config.entries).toContainEqual(
      expect.objectContaining({ kind: 'line', label: 'Color groups', path: '/project/colors', permission: 'project_color:project_color:read' }),
    )
  })

  it('filters the task lists by assignee and color group, without list columns for them', () => {
    for (const path of ['/project/tasks', '/project/my-tasks']) {
      const d = route(path).descriptor
      const only = d.search?.filterOnlyFields ?? []
      expect(only.map((f) => f.name), path).toEqual(['assignees', 'color_groups', 'pbs_item_id'])
      // The same fields as the form's, so labels and pickers match.
      for (const f of only) expect(f, path).toEqual(field('/project/tasks/:id', f.name))
      expect(d.fields.map((f) => f.name)).not.toContain('assignees')
    }
  })

  it('declares the risk list, its mind-map form with linked tasks, categories and menu', () => {
    expect(route('/project/risks').descriptor).toMatchObject({ entity: 'project_risk', viewType: 'tree', navLabel: 'Risks', formPath: '/project/risks/:id' })
    expect(route('/project/risk_categories').descriptor).toMatchObject({ entity: 'project_risk_category', viewType: 'tree', hideFromTopBar: true, formPath: '/project/risk_categories/:id' })
    expect(route('/project/risk_categories/:id').descriptor).toMatchObject({ entity: 'project_risk_category', viewType: 'form' })
    const form = route('/project/risks/:id').descriptor
    expect(form).toMatchObject({ entity: 'project_risk', viewType: 'form' })
    expect(field('/project/risks/:id', 'name').widget).toBeUndefined()
    expect(field('/project/risks/:id', 'risk_map')).toMatchObject({ widget: 'mindmap', store: false, readOnly: true })
    expect(field('/project/risks/:id', 'risk_map').widgetOptions).toEqual({
      center: 'name',
      satellites: [
        { field: 'category_id', label: 'Risk category', entity: 'project_risk_category' },
        { field: 'description', label: 'Risk type' },
        { field: 'phase_task_id', label: 'Project phase', entity: 'project_task' },
      ],
    })
    expect(field('/project/risks/:id', 'phase_task_id')).toMatchObject({ relation: { entity: 'project_task', filterFields: { project_id: 'project_id' } } })
    expect(field('/project/risks/:id', 'criticity').readOnly).toBe(true)
    expect(field('/project/risks/:id', 'linked_tasks')).toMatchObject({ relation: { entity: 'project_risk_task', kind: 'one2many', inverseField: 'risk_id' } })
    expect(field('/project/risks/:id', 'severity_note')).toMatchObject({ type: 'selection', readOnly: true, selection: { labels: { cycle: 'Dependency cycle' } } })
    // Every field of the form is in its layout (an explicit layout renders only the fields it names), once.
    const named: string[] = []
    const walk = (nodes: unknown[]) => nodes.forEach((n) => { const x = n as { kind: string; name?: string; children?: unknown[] }; if (x.kind === 'field') named.push(x.name!); else walk(x.children ?? []) })
    walk(form.layout!)
    expect(named.sort()).toEqual(form.fields.map((f) => f.name).sort())
    expect(field('/project/risks/:id', 'project_id').states).toEqual({ readOnly: { field: 'id', op: 'set' } })
    expect(route('/project/risk_tasks/:id').descriptor).toMatchObject({ entity: 'project_risk_task', viewType: 'form' })
    expect(field('/project/risk_tasks/:id', 'task_id')).toMatchObject({ required: true, relation: { entity: 'project_task', kind: 'many2one' } })
    expect(JSON.stringify(form.layout)).toContain('Linked tasks')
    const registry = new ModuleRegistry()
    registry.register(mod, { appMode: true })
    const config = registry.headerMenus().find((m) => m.module === 'project')!.menus.find((m) => m.label === 'Configuration')!
    expect(config.entries).toContainEqual(expect.objectContaining({ label: 'Risk categories', path: '/project/risk_categories', permission: 'project_risk_category:project_risk_category:read' }))
  })

  it('shows the trigger-maintained closed_at read-only on the task list and form', () => {
    for (const path of ['/project/tasks', '/project/tasks/:id']) {
      expect(field(path, 'closed_at'), path).toMatchObject({ type: 'date', widget: 'datetime', readOnly: true })
    }
  })

  it('lists and edits user capacities from the Configuration menu', () => {
    expect(route('/project/capacities').descriptor).toMatchObject({
      entity: 'project_capacity',
      viewType: 'tree',
      navLabel: 'Capacities',
      hideFromTopBar: true,
      formPath: '/project/capacities/:id',
    })
    expect(route('/project/capacities/:id').descriptor).toMatchObject({ entity: 'project_capacity', viewType: 'form' })
    expect(field('/project/capacities/:id', 'user_id')).toMatchObject({ type: 'relation', relation: { entity: 'users', kind: 'many2one' }, required: true })
    expect(field('/project/capacities/:id', 'hours_per_week')).toMatchObject({ type: 'number', required: true })
    const registry = new ModuleRegistry()
    registry.register(mod, { appMode: true })
    const config = registry.headerMenus().find((m) => m.module === 'project')!.menus.find((m) => m.label === 'Configuration')!
    expect(config.entries).toContainEqual(
      expect.objectContaining({ kind: 'line', label: 'Capacities', path: '/project/capacities', permission: 'project_capacity:project_capacity:read' }),
    )
  })

  it('declares the planning pages as hidden dashboards behind a Planning menu', () => {
    for (const [path, table] of [
      ['/project/my-day', 'project_task'],
      ['/project/timesheet-week', 'project_timesheet'],
      ['/project/workload', 'project_task'],
      ['/project/portfolio', 'project'],
    ] as const) {
      // Shell pages render themselves; the route only gates and keeps the
      // top bar on the Project's own menus (hideFromTopBar, Teams' trick).
      expect(route(path).descriptor, path).toMatchObject({ viewType: 'dashboard', fields: [], hideFromTopBar: true })
      expect(route(path).descriptor.entity, path).toBe(table)
      expect(route(path).permission, path).toBe(`${table}:${table}:read`)
    }
    // The app tile keeps pointing at the project list (the first route).
    expect(mod.routes[0].path).toBe('/project')
    const registry = new ModuleRegistry()
    registry.register(mod, { appMode: true })
    const menus = registry.headerMenus().find((m) => m.module === 'project')!.menus
    expect(menus.find((m) => m.label === 'Planning')?.entries).toEqual([
      { kind: 'line', label: 'My day', path: '/project/my-day', permission: 'project_task:project_task:read' },
      { kind: 'line', label: 'Timesheet week', path: '/project/timesheet-week', permission: 'project_timesheet:project_timesheet:read' },
      { kind: 'line', label: 'Workload', path: '/project/workload', permission: 'project_task:project_task:read' },
      { kind: 'line', label: 'Portfolio', path: '/project/portfolio', permission: 'project:project:read' },
    ])
    // The hidden routes add no top-bar menus of their own.
    expect(menus.map((m) => m.name)).not.toContain('/project/my-day')
    expect(menus.map((m) => m.name)).not.toContain('/project/timesheet-week')
  })
})
