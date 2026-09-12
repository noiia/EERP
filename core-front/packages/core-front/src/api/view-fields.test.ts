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
    })
  })

  it('resolves to disabled/null when neither the module nor Settings declares anything', () => {
    expect(effectiveViewFields(undefined, EMPTY_VIEW_FIELDS)).toEqual({
      kanbanStatusField: null,
      calendarDateField: null,
      enableGraphs: false,
      calendarColorField: null,
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
    })
  })

  it('calendarColorField is module-declared only — no Settings override path exists for it', () => {
    expect(
      effectiveViewFields({ calendarColorField: 'failed' }, EMPTY_VIEW_FIELDS).calendarColorField,
    ).toBe('failed')
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
      }),
    ).toEqual({ list: true, kanban: false, calendar: false, graph: false })
    expect(
      availableDisplayModes({
        kanbanStatusField: 'status',
        calendarDateField: 'due_date',
        enableGraphs: true,
        calendarColorField: null,
      }),
    ).toEqual({ list: true, kanban: true, calendar: true, graph: true })
  })
})
