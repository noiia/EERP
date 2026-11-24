import { describe, expect, it, vi } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { downloadRegister, registerCsv, registerPdf, registerXlsx } from './register-export'
import { registerTable } from './register-table'
import type { RiskRow } from './scoring'

const row = (o: Partial<RiskRow>): RiskRow => ({
  id: 'r', name: 'Risk', category_id: null, impact_on: 'delay', likelihood: 2, severity_effective: 3, criticity: 6,
  residual_likelihood: 1, residual_severity: 1, residual_criticity: 1, severity_note: null, ...o,
})
const table = registerTable(
  [
    row({ name: 'Late "vendor", again', category_id: 'c1', responsible_id: 'u1', deadline: '2026-12-01T00:00:00Z', remediation: '=HYPERLINK("x")' }),
    row({ name: 'Cycle <&>', severity_note: 'cycle', severity_effective: null, criticity: null, impact_on: 'cost' }),
  ],
  [{ id: 'c1', name: 'Internal' }],
  () => 'Alice',
  (s) => s,
)

describe('registerTable', () => {
  it('turns risks into display cells: names, labels, dates, not computable', () => {
    expect(table.rows[0]).toEqual(['Late "vendor", again', 'Internal', 'Delay', 2, 3, null, 6, '=HYPERLINK("x")', 'Alice', '2026-12-01', 1])
    expect(table.rows[1].slice(1, 5)).toEqual([null, 'Cost', 2, 'Not computable'])
    expect(table.rows[1][8]).toBeNull() // no responsible
  })
})

describe('registerCsv', () => {
  it('quotes, escapes and defuses formulas', () => {
    const csv = registerCsv(table)
    expect(csv.startsWith('﻿Risk,Category,')).toBe(true)
    const line = csv.split('\r\n')[1]
    expect(line).toBe(`"Late ""vendor"", again",Internal,Delay,2,3,,6,"'=HYPERLINK(""x"")",Alice,2026-12-01,1`)
  })
})

describe('registerXlsx', () => {
  it('writes a workbook with the sheet, escaped strings and numeric cells', () => {
    const files = unzipSync(registerXlsx(table, 'Risk register'))
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'])
    expect(strFromU8(files['xl/workbook.xml'])).toContain('name="Risk register"')
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Risk</t></is></c>')
    expect(sheet).toContain('<c r="D2"><v>2</v></c>')
    expect(sheet).toContain('Cycle &lt;&amp;&gt;')
    expect(sheet).not.toContain('r="F2"') // empty cell omitted
  })
  it('fills each row with its temperature color, one style per distinct color', () => {
    const files = unzipSync(registerXlsx({ ...table, fills: [[255, 0, 0], null] }))
    const styles = strFromU8(files['xl/styles.xml'])
    expect(styles).toContain('<fills count="3">')
    expect(styles).toContain('<fgColor rgb="FFFF0000"/>')
    expect(styles).toContain('<xf fillId="2" applyFill="1"/>')
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    expect(sheet).toContain('<row r="2" customFormat="1" s="2">')
    expect(sheet).toContain('<c r="D2" s="2"><v>2</v></c>')
    expect(sheet).toContain('<row r="3">')
  })
  it('cleans an invalid sheet name', () => {
    expect(strFromU8(unzipSync(registerXlsx(table, 'a/b:c*'.repeat(9)))['xl/workbook.xml'])).toMatch(/name="a b c [^"]{0,25}"/)
  })
})

describe('registerPdf', () => {
  const risks = [row({ name: 'Late vendor', criticity: 9, remediation: 'Second supplier', if_it_happens: 'Switch' }), row({ name: 'Cycle', criticity: null, residual_criticity: null })]
  it('draws the sheet and pages a long register', () => {
    const doc = registerPdf(risks, 'Apollo', new Date('2026-11-20'))
    const out = doc.output()
    for (const s of ['R1', 'Late vendor', 'Second supplier', 'If it happens', 'Residual']) expect(out).toContain(s)
    const long = Array.from({ length: 80 }, (_, i) => row({ id: String(i), criticity: i }))
    expect(registerPdf(long, 'Apollo', new Date('2026-11-20')).getNumberOfPages()).toBeGreaterThan(1)
  })
})

describe('downloadRegister', () => {
  it('saves CSV and XLSX through a link', () => {
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadRegister('csv', table, 'register-p1')
    downloadRegister('xlsx', table, 'register-p1')
    expect(click).toHaveBeenCalledTimes(2)
    click.mockRestore()
  })
})
