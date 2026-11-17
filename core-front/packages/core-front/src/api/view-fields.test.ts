import { describe, expect, it } from 'vitest'
import { availableDisplayModes, effectiveViewFields, EMPTY_VIEW_FIELDS, pinnedId } from './view-fields'

describe('effectiveViewFields', () => {
  it('falls back to the module default when nothing is overridden', () => {
    expect(
      effectiveViewFields(
        { kanbanStatusField: 'status', calendarDateField: 'due_date', enableGraphs: true },
        EMPTY_VIEW_FIELDS,
      ),
    ).toEqual({
      kanbanStatusField: 'status',
      calendarDateField: 'due_date',
      enableGraphs: true,
      calendarColorField: null,
      kanbanColumns: null,
      kanbanBadgeField: null,
      ganttStartField: null,
      ganttEndField: null,
      ganttDependencies: null,
      wbsParentField: null,
      wbsGroupField: null,
      wbsOrderField: null,
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
        obs: null,
        risk: null,
        ganttSchedule: null,
        ganttBaseline: null,
        kanbanSwimlanes: null,
        insights: null,
        matrix: null,
        pbs: null,
        wbsDeliverables: null,
    })
  })

  it('resolves to disabled/null when neither the module nor Settings declares anything', () => {
    expect(effectiveViewFields(undefined, EMPTY_VIEW_FIELDS)).toEqual({
      kanbanStatusField: null,
      calendarDateField: null,
      enableGraphs: false,
      calendarColorField: null,
      kanbanColumns: null,
      kanbanBadgeField: null,
      ganttStartField: null,
      ganttEndField: null,
      ganttDependencies: null,
      wbsParentField: null,
      wbsGroupField: null,
      wbsOrderField: null,
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
        obs: null,
        risk: null,
        ganttSchedule: null,
        ganttBaseline: null,
        kanbanSwimlanes: null,
        insights: null,
        matrix: null,
        pbs: null,
        wbsDeliverables: null,
    })
  })

  it("a non-null Settings override wins over the module's default, field by field", () => {
    expect(
      effectiveViewFields(
        { kanbanStatusField: 'status', enableGraphs: true },
        { kanbanStatusField: 'priority', calendarDateField: 'due_date', enableGraphs: false },
      ),
    ).toEqual({
      kanbanStatusField: 'priority',
      calendarDateField: 'due_date',
      enableGraphs: false,
      calendarColorField: null,
      kanbanColumns: null,
      kanbanBadgeField: null,
      ganttStartField: null,
      ganttEndField: null,
      ganttDependencies: null,
      wbsParentField: null,
      wbsGroupField: null,
      wbsOrderField: null,
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
        obs: null,
        risk: null,
        ganttSchedule: null,
        ganttBaseline: null,
        kanbanSwimlanes: null,
        insights: null,
        matrix: null,
        pbs: null,
        wbsDeliverables: null,
    })
  })

  it('an override left null (never touched) still inherits the module default', () => {
    expect(
      effectiveViewFields({ calendarDateField: 'due_date' }, { ...EMPTY_VIEW_FIELDS, kanbanStatusField: 'status' }),
    ).toEqual({
      kanbanStatusField: 'status',
      calendarDateField: 'due_date',
      enableGraphs: false,
      calendarColorField: null,
      kanbanColumns: null,
      kanbanBadgeField: null,
      ganttStartField: null,
      ganttEndField: null,
      ganttDependencies: null,
      wbsParentField: null,
      wbsGroupField: null,
      wbsOrderField: null,
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
        obs: null,
        risk: null,
        ganttSchedule: null,
        ganttBaseline: null,
        kanbanSwimlanes: null,
        insights: null,
        matrix: null,
        pbs: null,
        wbsDeliverables: null,
    })
  })

  it('calendarColorField is module-declared only — no Settings override path exists for it', () => {
    expect(
      effectiveViewFields({ calendarColorField: 'failed' }, EMPTY_VIEW_FIELDS).calendarColorField,
    ).toBe('failed')
  })

  it('colorTagsField is module-declared only', () => {
    expect(effectiveViewFields({ colorTagsField: 'color_groups' }, EMPTY_VIEW_FIELDS).colorTagsField).toBe('color_groups')
  })

  it('ganttDependencies is module-declared only', () => {
    const ganttDependencies = { entity: 'dep', fromField: 'depends_on_id', toField: 'task_id' }
    expect(effectiveViewFields({ ganttDependencies }, EMPTY_VIEW_FIELDS).ganttDependencies).toEqual(ganttDependencies)
  })

  it('kanbanColumns and kanbanBadgeField are module-declared only', () => {
    const kanbanColumns = { orderField: 'sequence', labelField: 'name' }
    expect(
      effectiveViewFields({ kanbanColumns, kanbanBadgeField: 'blocked' }, EMPTY_VIEW_FIELDS),
    ).toMatchObject({ kanbanColumns, kanbanBadgeField: 'blocked' })
  })
})

describe('availableDisplayModes', () => {
  it('list is always available; kanban/calendar/graph follow the effective config', () => {
    expect(
      availableDisplayModes({
        kanbanStatusField: null,
        calendarDateField: null,
        enableGraphs: false,
        calendarColorField: null,
        kanbanColumns: null,
        kanbanBadgeField: null,
        ganttStartField: null,
        ganttEndField: null,
        ganttDependencies: null,
      wbsParentField: null,
      wbsGroupField: null,
      wbsOrderField: null,
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
        obs: null,
        risk: null,
        ganttSchedule: null,
        ganttBaseline: null,
        kanbanSwimlanes: null,
        insights: null,
        matrix: null,
        pbs: null,
        wbsDeliverables: null,
      }),
    ).toEqual({ list: true, kanban: false, calendar: false, graph: false, gantt: false, wbs: false, pert: false, obs: false, risk: false, insights: false, matrix: false, pbs: false })
    expect(
      availableDisplayModes({
        kanbanStatusField: 'status',
        calendarDateField: 'due_date',
        enableGraphs: true,
        calendarColorField: null,
        kanbanColumns: null,
        kanbanBadgeField: null,
        ganttStartField: null,
        ganttEndField: null,
        ganttDependencies: null,
      wbsParentField: null,
      wbsGroupField: null,
      wbsOrderField: null,
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
        obs: null,
        risk: null,
        ganttSchedule: null,
        ganttBaseline: null,
        kanbanSwimlanes: null,
        insights: null,
        matrix: null,
        pbs: null,
        wbsDeliverables: null,
      }),
    ).toEqual({ list: true, kanban: true, calendar: true, graph: true, gantt: false, wbs: false, pert: false, obs: false, risk: false, insights: false, matrix: false, pbs: false })
  })

  it('gantt needs BOTH a start and an end field', () => {
    const base = effectiveViewFields(undefined, EMPTY_VIEW_FIELDS)
    expect(availableDisplayModes({ ...base, ganttStartField: 'date_start' }).gantt).toBe(false)
    expect(availableDisplayModes({ ...base, ganttEndField: 'deadline' }).gantt).toBe(false)
    expect(availableDisplayModes({ ...base, ganttStartField: 'date_start', ganttEndField: 'deadline' }).gantt).toBe(true)
  })
})

describe('effectiveViewFields gantt fields', () => {
  it('inherit the module default and yield to a non-null override, field by field', () => {
    expect(
      effectiveViewFields(
        { ganttStartField: 'date_start', ganttEndField: 'deadline' },
        { ...EMPTY_VIEW_FIELDS, ganttEndField: 'due_date' },
      ),
    ).toMatchObject({ ganttStartField: 'date_start', ganttEndField: 'due_date' })
  })
})

describe('wbs / pert modes', () => {
  const dep = { entity: 'project_task_dependency', fromField: 'blocker_id', toField: 'task_id' }

  it('wbs is available only with wbsParentField', () => {
    expect(availableDisplayModes(effectiveViewFields(undefined, EMPTY_VIEW_FIELDS)).wbs).toBe(false)
    expect(availableDisplayModes(effectiveViewFields({ wbsParentField: 'parent_id' }, EMPTY_VIEW_FIELDS)).wbs).toBe(true)
  })

  it('pert is available only with pertDependencies', () => {
    expect(availableDisplayModes(effectiveViewFields(undefined, EMPTY_VIEW_FIELDS)).pert).toBe(false)
    expect(availableDisplayModes(effectiveViewFields({ pertDependencies: dep }, EMPTY_VIEW_FIELDS)).pert).toBe(true)
  })

  it('carries the module defaults into the effective config', () => {
    expect(
      effectiveViewFields(
        { wbsParentField: 'parent_id', wbsGroupField: 'stage_id', pertDependencies: dep, pertHoursField: 'planned_hours' },
        EMPTY_VIEW_FIELDS,
      ),
    ).toMatchObject({ wbsParentField: 'parent_id', wbsGroupField: 'stage_id', pertDependencies: dep, pertHoursField: 'planned_hours' })
  })
})

describe('pinnedId / obs availability', () => {
  it('pinnedId reads one filter or one in id, else null', () => {
    expect(pinnedId({ filter: { project_id: 'p1' } }, 'project_id')).toBe('p1')
    expect(pinnedId({ in: { project_id: ['p1'] } }, 'project_id')).toBe('p1')
    expect(pinnedId(undefined, 'project_id')).toBeNull()
    expect(pinnedId({ in: { project_id: ['p1', 'p2'] } }, 'project_id')).toBeNull()
    expect(pinnedId({ filter: { project_id: '' } }, 'project_id')).toBeNull()
  })

  it('obs needs a module config and a pinned project', () => {
    const obs = { entity: 'project_obs_box', projectField: 'project_id', projectEntity: 'project', companyField: 'company_id' }
    const eff = effectiveViewFields({ obs }, EMPTY_VIEW_FIELDS)
    expect(eff.obs).toEqual(obs)
    expect(availableDisplayModes(eff).obs).toBe(false)
    expect(availableDisplayModes(eff, { filter: { project_id: 'p1' } }).obs).toBe(true)
    expect(availableDisplayModes(effectiveViewFields(undefined, EMPTY_VIEW_FIELDS), { filter: { project_id: 'p1' } }).obs).toBe(false)
  })
})

describe('risk availability', () => {
  const risk = { entity: 'project_risk', linkEntity: 'project_risk_link', categoryEntity: 'project_risk_category', projectField: 'project_id', formPath: '/project/risks/:id' }
  it('needs a module config and a pinned project', () => {
    const eff = effectiveViewFields({ risk }, EMPTY_VIEW_FIELDS)
    expect(eff.risk).toEqual(risk)
    expect(availableDisplayModes(eff).risk).toBe(false)
    expect(availableDisplayModes(eff, { filter: { project_id: 'p1' } }).risk).toBe(true)
    expect(availableDisplayModes(effectiveViewFields(undefined, EMPTY_VIEW_FIELDS), { filter: { project_id: 'p1' } }).risk).toBe(false)
  })
})

describe('insights availability', () => {
  const insights = { projectField: 'project_id', projectEntity: 'project', metricsPath: 'metrics', milestoneEntity: 'project_milestone' }
  it('needs a module config and a pinned project', () => {
    const eff = effectiveViewFields({ insights }, EMPTY_VIEW_FIELDS)
    expect(eff.insights).toEqual(insights)
    expect(availableDisplayModes(eff).insights).toBe(false)
    expect(availableDisplayModes(eff, { filter: { project_id: 'p1' } }).insights).toBe(true)
    expect(availableDisplayModes(effectiveViewFields(undefined, EMPTY_VIEW_FIELDS), { filter: { project_id: 'p1' } }).insights).toBe(false)
  })
})

describe('matrix availability', () => {
  const matrix = {
    projectField: 'project_id',
    raciEntity: 'project_task_raci',
    userLabelField: 'email',
    dependencies: { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' },
    priorityField: 'priority',
    deadlineField: 'deadline',
    closedField: 'closed',
    urgentDays: 7,
  }
  it('needs a module config and a pinned project', () => {
    const eff = effectiveViewFields({ matrix }, EMPTY_VIEW_FIELDS)
    expect(eff.matrix).toEqual(matrix)
    expect(availableDisplayModes(eff).matrix).toBe(false)
    expect(availableDisplayModes(eff, { filter: { project_id: 'p1' } }).matrix).toBe(true)
    expect(availableDisplayModes(effectiveViewFields(undefined, EMPTY_VIEW_FIELDS), { filter: { project_id: 'p1' } }).matrix).toBe(false)
  })
})

describe('pbs availability', () => {
  const pbs = { entity: 'project_pbs_item', projectField: 'project_id', projectEntity: 'project', taskField: 'pbs_item_id' }
  it('needs a module config and a pinned project', () => {
    const eff = effectiveViewFields({ pbs }, EMPTY_VIEW_FIELDS)
    expect(eff.pbs).toEqual(pbs)
    expect(availableDisplayModes(eff).pbs).toBe(false)
    expect(availableDisplayModes(eff, { filter: { project_id: 'p1' } }).pbs).toBe(true)
    expect(availableDisplayModes(effectiveViewFields(undefined, EMPTY_VIEW_FIELDS), { filter: { project_id: 'p1' } }).pbs).toBe(false)
  })
})

describe('gantt schedule, baseline and kanban swimlanes configs', () => {
  it('carry the module defaults into the effective config, module-declared only', () => {
    const ganttSchedule = { scopeField: 'project_id', scopeEntity: 'project', path: 'schedule' }
    const ganttBaseline = { entity: 'project_baseline', taskEntity: 'project_baseline_task', scopeField: 'project_id', linkField: 'task_id', startField: 'date_start', endField: 'deadline' }
    const kanbanSwimlanes = { label: 'Assignee', via: 'project_task_user', ownField: 'task_id', relatedField: 'user_id', entity: 'users', labelField: 'email' }
    expect(
      effectiveViewFields({ ganttSchedule, ganttBaseline, kanbanSwimlanes }, EMPTY_VIEW_FIELDS),
    ).toMatchObject({ ganttSchedule, ganttBaseline, kanbanSwimlanes })
    // Declared none: every one resolves null, the mode stays off.
    expect(effectiveViewFields(undefined, EMPTY_VIEW_FIELDS)).toMatchObject({
      ganttSchedule: null,
      ganttBaseline: null,
      kanbanSwimlanes: null,
      insights: null,
      matrix: null,
    })
  })
})
