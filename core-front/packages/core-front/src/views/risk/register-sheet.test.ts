import { describe, expect, it } from 'vitest'
import { RESIDUAL_COLORS, cellFill, registerSheet } from './register-sheet'
import type { RiskRow } from './scoring'

const row = (o: Partial<RiskRow>): RiskRow => ({
  id: 'r', name: 'Risk', category_id: null, impact_on: 'delay', likelihood: 2, severity_effective: 3, criticity: 6,
  residual_likelihood: 1, residual_severity: 1, residual_criticity: 1, severity_note: null, ...o,
})

describe('registerSheet', () => {
  it('numbers rows, colors them by relative criticity and the residual by band', () => {
    const s = registerSheet([row({ name: 'Hi', criticity: 18, residual_criticity: 8 }), row({ name: 'Lo', criticity: 8, remediation: 'Fix' }), row({ name: 'None', criticity: null, residual_criticity: null })])
    expect(s.range).toEqual([8, 18])
    expect(s.rows.map((r) => r.cells.slice(0, 3))).toEqual([['R1', 'Hi', '—'], ['R2', 'Lo', 'Fix'], ['R3', 'None', '—']])
    const [hi, lo, none] = s.rows
    expect(hi.num_fill![0]).toBeGreaterThan(200) // the highest listed is red
    expect(lo.num_fill![1]).toBeGreaterThan(lo.num_fill![0]) // the lowest green
    expect(cellFill(hi, 5)).toEqual(RESIDUAL_COLORS.medium)
    expect(cellFill(lo, 5)).toEqual(RESIDUAL_COLORS.low)
    expect(cellFill(hi, 2)).toEqual(hi.body_fill)
    expect(cellFill(hi, 4)).toEqual(hi.criticity_fill)
    expect([none.num_fill, none.body_fill, none.residual_fill]).toEqual([null, null, null])
    expect(registerSheet([]).range).toBeNull()
  })
})
