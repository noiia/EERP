import { describe, expect, it } from 'vitest'
import { computePert, offsetToDate, taskDuration } from './pert'

const t = (id: string, days: number) => ({ id, plannedHours: days * 8 })

describe('taskDuration', () => {
  it('uses planned hours', () => expect(taskDuration({ id: 'a', plannedHours: 16 })).toEqual({ days: 2, noEstimate: false }))
  it('hours win over dates', () =>
    expect(taskDuration({ id: 'a', plannedHours: 8, dateStart: '2026-01-01T00:00:00Z', deadline: '2026-01-10T00:00:00Z' }).days).toBe(1))
  it('falls back to dates', () =>
    expect(taskDuration({ id: 'a', dateStart: '2026-01-01T00:00:00Z', deadline: '2026-01-04T00:00:00Z' })).toEqual({ days: 3, noEstimate: false }))
  it.each([
    ['inverted', { dateStart: '2026-01-04T00:00:00Z', deadline: '2026-01-01T00:00:00Z' }],
    ['equal', { dateStart: '2026-01-04T00:00:00Z', deadline: '2026-01-04T00:00:00Z' }],
    ['only start', { dateStart: '2026-01-04T00:00:00Z' }],
    ['only deadline', { deadline: '2026-01-04T00:00:00Z' }],
    ['zero hours', { plannedHours: 0 }],
  ])('%s is no estimate', (_n, extra) => expect(taskDuration({ id: 'a', ...extra })).toEqual({ days: 1, noEstimate: true }))
})

describe('computePert', () => {
  it('chain', () => {
    const r = computePert([t('A', 2), t('B', 3), t('C', 1)], [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }])
    expect(r.finish).toBe(6)
    for (const n of Object.values(r.nodes)) expect(n.critical && n.slack === 0).toBe(true)
    expect([...r.criticalLinks].sort()).toEqual(['A->B', 'B->C'])
  })
  it('diamond', () => {
    const r = computePert(
      [t('A', 1), t('B', 5), t('C', 2), t('D', 1)],
      [{ from: 'A', to: 'B' }, { from: 'B', to: 'D' }, { from: 'A', to: 'C' }, { from: 'C', to: 'D' }],
    )
    expect(r.nodes.C.slack).toBe(3)
    expect(r.nodes.B.critical).toBe(true)
    expect(r.nodes.C.critical).toBe(false)
    expect(r.criticalLinks.has('A->C')).toBe(false)
    expect(r.criticalLinks.has('A->B')).toBe(true)
  })
  it('parallel critical chains', () => {
    const r = computePert([t('A', 2), t('B', 2), t('C', 2), t('D', 2)], [{ from: 'A', to: 'B' }, { from: 'C', to: 'D' }])
    expect(Object.values(r.nodes).every((n) => n.critical)).toBe(true)
  })
  it('ignores links to tasks outside the set', () => {
    const r = computePert([t('A', 2)], [{ from: 'A', to: 'Z' }])
    expect(r.hiddenLinks).toBe(1)
    expect(r.nodes.A.critical).toBe(true)
  })
  it('cycle', () => {
    const r = computePert([t('A', 1), t('B', 1), t('C', 1)], [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }, { from: 'B', to: 'C' }])
    expect([...(r.cycle ?? [])].sort()).toEqual(['A', 'B'])
    expect(Object.values(r.nodes).some((n) => n.critical)).toBe(false)
  })
  it('origin', () => {
    const r = computePert([{ id: 'A', dateStart: '2026-03-02T00:00:00Z' }, { id: 'B', dateStart: '2026-02-01T00:00:00Z' }], [])
    expect(r.origin.toISOString()).toBe('2026-02-01T00:00:00.000Z')
    const today = new Date(2026, 5, 7, 15, 30)
    expect(computePert([t('A', 1)], [], today).origin).toEqual(new Date(2026, 5, 7))
    expect(offsetToDate(new Date(Date.UTC(2026, 0, 1)), 2).toISOString()).toBe('2026-01-03T00:00:00.000Z')
  })
})
