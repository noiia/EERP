import { describe, expect, it, vi } from 'vitest'
import { behaviorRegistry, headerButtonRegistry, kanbanColumnsGuard, ModuleRegistry } from '@eerp/core-front'
import mod, { projectTasksPath, remainingHours } from './project_views'

const route = (path: string) => mod.routes.find((r) => r.path === path)!
const field = (path: string, name: string) => route(path).descriptor.fields.find((f) => f.name === name)!

describe('project views', () => {
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
    expect(menus.map((m) => m.label)).toEqual(['Projects', 'Tasks', 'My tasks', 'Milestones', 'Timesheets', 'Configuration'])
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

  it('gives the task form its five notebook pages', () => {
    const registry = new ModuleRegistry()
    registry.register(mod, { appMode: true })
    const notebook = JSON.stringify(registry.formDescriptorFor('project_task')!.layout)
    for (const title of ['Description', 'Subtasks', 'Blocked by', 'Blocking', 'Timesheets']) {
      expect(notebook).toContain(`"title":"${title}"`)
    }
    expect(field('/project/tasks/:id', 'subtasks').relation).toMatchObject({ kind: 'one2many', inverseField: 'parent_id' })
    const timesheets = field('/project/tasks/:id', 'timesheets')
    expect(timesheets.relation).toMatchObject({ kind: 'one2many', inverseField: 'task_id', labelField: 'date' })
    expect((timesheets.widgetOptions!.columns as { key: string }[]).map((c) => c.key)).toEqual(['user_id', 'hours', 'description'])
    expect(field('/project/tasks/:id', 'blocked_by').relation).toMatchObject({ via: 'project_task_dependency', viaFields: { own: 'task_id', related: 'depends_on_id' } })
    expect(field('/project/tasks/:id', 'blocking')).toMatchObject({ readOnly: true, relation: { viaFields: { own: 'depends_on_id', related: 'task_id' } } })
  })

  it('scopes stage, milestone and parent to the task\'s project', () => {
    for (const name of ['stage_id', 'milestone_id', 'parent_id']) {
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
})
