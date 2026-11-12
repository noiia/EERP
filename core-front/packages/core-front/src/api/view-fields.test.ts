import { describe, expect, it } from 'vitest'
import { availableDisplayModes, effectiveViewFields, EMPTY_VIEW_FIELDS } from './view-fields'

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
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
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
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
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
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
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
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
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
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
      }),
    ).toEqual({ list: true, kanban: false, calendar: false, graph: false, gantt: false, wbs: false, pert: false })
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
      pertDependencies: null,
      pertHoursField: null,
      colorTagsField: null,
      }),
    ).toEqual({ list: true, kanban: true, calendar: true, graph: true, gantt: false, wbs: false, pert: false })
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
