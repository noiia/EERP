import { describe, expect, it, vi } from 'vitest'
import { headerButtonRegistry, headerMenuRegistry, ModuleRegistry, useEntityRefreshStore } from '@eerp/core-front'
import mod from './EventViews'

describe('event views', () => {
  it('registers valid routes under the Website app', () => {
    const registry = new ModuleRegistry()
    registry.register(mod) // throws on an invalid descriptor or extension
    expect(mod.routes.every((r) => r.path.startsWith('/website/'))).toBe(true)
    const menus = headerMenuRegistry.forModule('website')
    expect(menus.find((m) => m.name === 'events')?.entries.map((e) => e.label)).toEqual(['Events', 'Bookings'])
  })

  it('shows sessions or availability depending on kind', () => {
    const form = mod.routes.find((r) => r.path === '/website/events/:id')!.descriptor
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
})
