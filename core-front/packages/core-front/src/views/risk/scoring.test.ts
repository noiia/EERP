import { describe, expect, it } from 'vitest'
import { band, ishikawaBones, matrixCells, type RiskRow } from './scoring'

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
