import { describe, expect, it } from 'vitest'
import { band, heatColors, ishikawaBones, matrixCells, tint, type RiskRow } from './scoring'

const row = (id: string, o: Partial<RiskRow> = {}): RiskRow => ({
  id, name: id, category_id: null, impact_on: 'delay', likelihood: 2, severity_effective: 3, criticity: 6,
  residual_likelihood: 1, residual_severity: 1, residual_criticity: 1, severity_note: null, ...o,
})

describe('band', () => {
  it.each([[null, null], [4, 'low'], [5, 'medium'], [12, 'medium'], [13, 'high']])('%s -> %s', (c, b) => {
    expect(band(c as number | null)).toBe(b)
  })
})

describe('matrixCells', () => {
  it('uses residual scores and skips rows without severity', () => {
    const rows = [row('a'), row('b', { severity_effective: null, residual_severity: null })]
    expect([...matrixCells(rows, false).keys()]).toEqual(['2:3'])
    expect([...matrixCells(rows, true).keys()]).toEqual(['1:1'])
  })
})

describe('ishikawaBones', () => {
  it('orders bones by name, uncategorized last, risks by criticity desc nulls last', () => {
    const rows = [
      row('n', { category_id: 'c2', criticity: null }), row('lo', { category_id: 'c2', criticity: 2 }),
      row('hi', { category_id: 'c2', criticity: 9 }), row('x', { category_id: 'c1' }), row('u'),
    ]
    const bones = ishikawaBones(rows, [{ id: 'c2', name: 'Zeta' }, { id: 'c1', name: 'Alpha' }])
    expect(bones.map((b) => b.name)).toEqual(['Alpha', 'Zeta', 'Uncategorized'])
    expect(bones[1].risks.map((r) => r.id)).toEqual(['hi', 'lo', 'n'])
  })
})

describe('heatColors', () => {
  it('runs from green on the lowest listed criticity to red on the highest', () => {
    const [lo, mid, none, hi] = heatColors([2, 5, null, 8])
    expect(none).toBeNull()
    expect(lo![1]).toBeGreaterThan(Math.max(lo![0], lo![2]))
    expect(hi![0]).toBeGreaterThan(200)
    expect(Math.max(hi![1], hi![2])).toBeLessThan(60)
    expect(mid).not.toEqual(lo)
    expect(mid).not.toEqual(hi)
    // Relative: the same criticity is red when it is the highest of the list.
    expect(heatColors([1, 8])[1]).toEqual(heatColors([3, 8])[1])
    expect(heatColors([4, 4])).toEqual([hi, hi])
    expect(heatColors([null])).toEqual([null])
    expect(tint([0, 0, 0], 1)).toEqual([255, 255, 255])
  })
})
