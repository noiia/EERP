import { describe, expect, it } from 'vitest'
import cron from './CronViews'

describe('cron FrontModule', () => {
  it('is named "cron" and registers both entities routes', () => {
    expect(cron.name).toBe('cron')
    expect(cron.routes.map((r) => r.path)).toEqual([
      '/cron',
      '/cron/:id',
      '/cron_history',
      '/cron_history/:id',
    ])
  })

  it('wires a tree list and a form over the cron entity', () => {
    const list = cron.routes.find((r) => r.path === '/cron')!
    const form = cron.routes.find((r) => r.path === '/cron/:id')!
    expect(list.descriptor.viewType).toBe('tree')
    expect(form.descriptor.viewType).toBe('form')
    expect([list, form].every((r) => r.descriptor.entity === 'cron')).toBe(true)
  })

  it('defaults Kanban to the status field and Calendar to execution_date', () => {
    const list = cron.routes.find((r) => r.path === '/cron')!
    expect(list.descriptor.viewModeDefaults).toEqual({
      kanbanStatusField: 'status',
      calendarDateField: 'execution_date',
    })
  })

  it('gates the Create button on cron:cron:write', () => {
    const list = cron.routes.find((r) => r.path === '/cron')!
    expect(list.descriptor.createPermission).toBe('cron:cron:write')
  })

  it('exposes action_code as a read-only long field (lands on the notebook first page)', () => {
    const form = cron.routes.find((r) => r.path === '/cron/:id')!
    const field = form.descriptor.fields.find((f) => f.name === 'action_code')
    expect(field?.widget).toBe('long')
    expect(field?.readOnly).toBe(true)
  })

  it('exposes the cron history as a read-only one2many relation on the form', () => {
    const form = cron.routes.find((r) => r.path === '/cron/:id')!
    const field = form.descriptor.fields.find((f) => f.name === 'history')
    expect(field?.type).toBe('relation')
    expect(field?.relation).toEqual({
      entity: 'cron_history',
      kind: 'one2many',
      inverseField: 'cron_id',
      labelField: 'created_at',
    })
  })

  it('cron_history has no createPermission (system-written only) and colors failed runs red on Calendar', () => {
    const list = cron.routes.find((r) => r.path === '/cron_history')!
    expect(list.descriptor.createPermission).toBeUndefined()
    expect(list.descriptor.viewModeDefaults).toEqual({
      calendarDateField: 'created_at',
      calendarColorField: 'failed',
    })
  })

  it('cron_history form offers a Download log action', () => {
    const form = cron.routes.find((r) => r.path === '/cron_history/:id')!
    expect(form.descriptor.actions).toEqual([
      { kind: 'action', label: 'Download log', action: 'cron_history.downloadLog' },
    ])
  })
})
