import { describe, expect, it, vi } from 'vitest'
import { headerButtonRegistry, resolveWidget, headerMenuRegistry, ModuleRegistry, useEntityRefreshStore } from '@eerp/core-front'
import contacts from '../../contact/views/contact_views'
import mod from './EventViews'

describe('event views', () => {
  it('registers a standalone Event app under /event', () => {
    const registry = new ModuleRegistry()
    registry.register(contacts) // the event module extends the contact form
    registry.register(mod, { appMode: true }) // throws on an invalid descriptor or extension
    expect(mod.routes.every((r) => r.path === '/event' || r.path.startsWith('/event/'))).toBe(true)
    for (const list of ['/event', '/event/sessions', '/event/bookings', '/event/availability']) {
      expect(mod.routes.find((r) => r.path === list)?.descriptor.viewType).toBe('tree')
      const form = list === '/event' ? '/event/:id' : `${list}/:id`
      expect(mod.routes.find((r) => r.path === form)?.descriptor.viewType).toBe('form')
    }
    expect(registry.menu().map((m) => m.name)).toContain('event')

    const menus = registry.headerMenus().find((m) => m.module === 'event')!.menus
    expect(menus.map((m) => m.label)).toEqual(['Events', 'Sessions', 'Bookings', 'Configuration'])
    expect(menus.at(-1)!.entries.map((e) => e.label)).toEqual(['Settings', 'Availability', 'Email templates'])
    expect(headerMenuRegistry.forModule('website').some((m) => m.name === 'events')).toBe(false)
  })

  it('opens o2m rows in the Event app forms', () => {
    const form = mod.routes.find((r) => r.path === '/event/:id')!.descriptor
    const paths = form.fields.filter((f) => f.relation?.kind === 'one2many').map((f) => f.relation!.formPath)
    expect(paths).toEqual(['/event/sessions/:id', '/event/availability/:id', '/event/bookings/:id'])
  })

  it('places the event on a map and shows a booking its attendee distance', () => {
    const form = mod.routes.find((r) => r.path === '/event/:id')!.descriptor
    const geo = form.fields.find((f) => f.name === 'geo_location')!
    expect(geo).toMatchObject({ type: 'geo', widget: 'point' })
    expect(resolveWidget(geo)).toBe('point')
    const booking = mod.routes.find((r) => r.path === '/event/bookings/:id')!.descriptor
    const dist = booking.fields.find((f) => f.name === 'distance_to_event')!
    expect(dist.type).toBe('distance')
    expect(dist.widgetOptions).toEqual({
      from: { entity: 'contact', id: 'contact_id', field: 'geo_location' },
      to: { entity: 'event', id: 'event_id', field: 'geo_location' },
    })
    expect(resolveWidget(dist)).toBe('meters')
  })

  it('shows sessions or availability depending on kind', () => {
    const form = mod.routes.find((r) => r.path === '/event/:id')!.descriptor
    const field = (name: string) => form.fields.find((f) => f.name === name)!
    expect(field('sessions').states?.visible).toEqual({ field: 'kind', op: 'eq', value: 'sessions' })
    expect(field('availability').states?.visible).toEqual({ field: 'kind', op: 'eq', value: 'appointment' })
    expect(field('slot_minutes').states?.visible).toEqual({ field: 'kind', op: 'eq', value: 'appointment' })
  })

  it('repeat weekly creates N copies of the latest session one week apart', async () => {
    const create = vi.fn(async (_e: string, body: Record<string, unknown>) => ({ id: 'x', ...body }))
    const list = vi.fn(async () => [
      { id: 's0', event_id: 'e1', starts_at: '2026-09-28T09:00:00Z', ends_at: '2026-09-28T10:00:00Z', capacity: 5, price: null },
      { id: 's1', event_id: 'e1', starts_at: '2026-10-05T09:00:00Z', ends_at: '2026-10-05T10:00:00Z', capacity: 8, price: null },
    ])
    const before = useEntityRefreshStore.getState().bumps.event_session ?? 0
    await headerButtonRegistry.get('event.duplicateWeekly')!.handler({
      entity: 'event',
      recordId: 'e1',
      draft: { repeat_weeks: 3 },
      setFieldAndCommit: async () => null,
      relationOps: { list, create } as never,
    })
    expect(list).toHaveBeenCalledWith('event_session', { filter: { event_id: 'e1' }, pageSize: 200 })
    expect(create.mock.calls.map((c) => c[1].starts_at)).toEqual([
      '2026-10-12T09:00:00.000Z',
      '2026-10-19T09:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
    ])
    expect(create.mock.calls[0][1]).toMatchObject({ event_id: 'e1', capacity: 8, ends_at: '2026-10-12T10:00:00.000Z' })
    expect(useEntityRefreshStore.getState().bumps.event_session).toBe(before + 1)
  })

  it('repeat weekly does nothing for an out-of-range count', async () => {
    const create = vi.fn()
    await headerButtonRegistry.get('event.duplicateWeekly')!.handler({
      entity: 'event',
      recordId: 'e1',
      draft: { repeat_weeks: 0 },
      setFieldAndCommit: async () => null,
      relationOps: { list: vi.fn(), create } as never,
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('cancel booking commits status cancelled', async () => {
    const setFieldAndCommit = vi.fn(async () => null)
    await headerButtonRegistry.get('event.cancelBooking')!.handler({
      entity: 'event_booking',
      recordId: 'b1',
      draft: {},
      setFieldAndCommit,
      relationOps: null,
    })
    expect(setFieldAndCommit).toHaveBeenCalledWith({ status: 'cancelled' })
  })

  it('records attendance from the booking form', async () => {
    for (const [name, status] of [['event.checkIn', 'attended'], ['event.noShow', 'no_show']] as const) {
      const setFieldAndCommit = vi.fn(async () => null)
      await headerButtonRegistry.get(name)!.handler({
        entity: 'event_booking',
        recordId: 'b1',
        draft: {},
        setFieldAndCommit,
        relationOps: null,
      })
      expect(setFieldAndCommit).toHaveBeenCalledWith({ status })
    }
    const form = mod.routes.find((r) => r.path === '/event/bookings/:id')!.descriptor
    const visible = (name: string) => form.headerButtons!.find((b) => b.name === name)!.states!.visible
    // Shown once check-in opens, 1 h before the start (Go enforces the same rule).
    const opens = { field: 'starts_at', op: 'before_now', value: 60 }
    expect(visible('event.checkIn')).toEqual({ all: [{ field: 'id', op: 'set' }, { field: 'status', op: 'in', value: ['confirmed', 'no_show'] }, opens] })
    expect(visible('event.noShow')).toEqual({ all: [{ field: 'id', op: 'set' }, { field: 'status', op: 'in', value: ['confirmed', 'attended'] }, opens] })
    expect(form.fields.find((f) => f.name === 'starts_at')).toMatchObject({ readOnly: true, widget: 'datetime' })
    const status = form.fields.find((f) => f.name === 'status')!
    expect(status.selection?.options).toEqual(['waitlisted', 'pending_payment', 'confirmed', 'attended', 'no_show', 'cancelled', 'expired'])
  })

  it('ships kanban, calendar and graph defaults', () => {
    const list = (path: string) => mod.routes.find((r) => r.path === path)!.descriptor
    expect(list('/event/bookings').viewModeDefaults).toEqual({ kanbanStatusField: 'status', calendarDateField: 'starts_at', enableGraphs: true })
    expect(list('/event/sessions').viewModeDefaults).toEqual({ calendarDateField: 'starts_at', enableGraphs: true })
    expect(list('/event').viewModeDefaults).toEqual({ kanbanStatusField: 'kind' })
    const bookingCols = list('/event/bookings').fields.map((f) => f.name)
    expect(bookingCols).toEqual(expect.arrayContaining(['event_id', 'starts_at', 'status']))
  })

  it('shows the event picture in the form header', () => {
    const form = mod.routes.find((r) => r.path === '/event/:id')!.descriptor
    expect(form.fields[0]).toMatchObject({ name: 'picture', type: 'boolean', widget: 'picture' })
  })

  it('prices events with a sale product and marks booking invoices paid', async () => {
    const eventForm = mod.routes.find((r) => r.path === '/event/:id')!.descriptor
    expect(eventForm.fields.find((f) => f.name === 'product_variant_id')?.relation).toMatchObject({ entity: 'product_variant', kind: 'many2one' })
    const form = mod.routes.find((r) => r.path === '/event/bookings/:id')!.descriptor
    expect(form.fields.find((f) => f.name === 'invoice_id')).toMatchObject({ widget: 'summary', relation: { entity: 'invoice' } })
    expect(form.headerButtons!.find((b) => b.name === 'event.markPaid')!.states!.visible).toEqual({
      all: [{ field: 'id', op: 'set' }, { field: 'invoice_id', op: 'set' }, { field: 'paid_at', op: 'unset' }],
    })
    const setFieldAndCommit = vi.fn(async () => null)
    await headerButtonRegistry.get('event.markPaid')!.handler({ entity: 'event_booking', recordId: 'b1', draft: {}, setFieldAndCommit, relationOps: null })
    expect(setFieldAndCommit).toHaveBeenCalledWith({ paid_at: expect.any(String) })
  })

  it("adds a Bookings tab to the contact form", () => {
    const registry = new ModuleRegistry()
    registry.register(contacts)
    registry.register(mod)
    const form = registry.formDescriptorFor('contact')!
    const field = form.fields.find((f) => f.name === 'event_bookings')
    expect(field?.relation).toMatchObject({ entity: 'event_booking', kind: 'one2many', inverseField: 'contact_id', formPath: '/event/bookings/:id' })
  })
})
