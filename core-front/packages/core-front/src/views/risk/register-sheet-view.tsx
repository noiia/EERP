'use client'
import { forwardRef } from 'react'
import { useT } from '../../i18n/translate'
import type { RiskRow } from './scoring'
import { RESIDUAL_COLORS, SHEET_HEADER, SHEET_HEADS, SHEET_INK, SHEET_WIDTHS, cellFill, legendScale, registerSheet, rgb } from './register-sheet'

// The register's PNG: the sheet (register-sheet.ts) as plain HTML with fixed light colors, never the
// ERP theme, so a dark-mode user still exports a white register.
const total = SHEET_WIDTHS.reduce((a, b) => a + b, 0)
const font = 'Lato, "Helvetica Neue", Arial, sans-serif'

export const RegisterSheetView = forwardRef<HTMLDivElement, { rows: RiskRow[]; title: string }>(function RegisterSheetView({ rows, title }, ref) {
  const t = useT()
  const sheet = registerSheet(rows)
  const cell = { padding: '10px 12px', border: '2px solid #fff', textAlign: 'center' as const, verticalAlign: 'middle' as const }
  const swatch = (c: string) => <span style={{ display: 'inline-block', width: 10, height: 10, background: c, marginRight: 6 }} />
  return (
    <div ref={ref} data-testid="register-export" style={{ width: 1600, padding: 24, background: '#fff', color: rgb(SHEET_INK), fontFamily: font, fontSize: 14 }}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>{title}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>{SHEET_WIDTHS.map((w, i) => <col key={i} style={{ width: `${(w / total) * 100}%` }} />)}</colgroup>
        <thead>
          <tr>{SHEET_HEADS.map((h) => <th key={h} style={{ ...cell, background: rgb(SHEET_HEADER), color: '#fff', fontWeight: 700 }}>{t(h)}</th>)}</tr>
        </thead>
        <tbody>
          {sheet.rows.map((r) => (
            <tr key={r.num}>
              {r.cells.map((v, i) => {
                const fill = cellFill(r, i)
                return (
                  <td key={i} style={{ ...cell, background: fill ? rgb(fill) : undefined, fontWeight: i === 0 || i === 1 || i >= 4 ? 700 : 400, fontSize: i >= 4 ? 16 : 14 }}>{v}</td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginTop: 16, fontSize: 13 }}>
        {sheet.range && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('Criticity')} {sheet.range[0]}
            <span style={{ display: 'inline-block', width: 120, height: 10, background: `linear-gradient(to right, ${legendScale().map(rgb).join(', ')})` }} />
            {sheet.range[1]}
          </span>
        )}
        <span>
          {t('Residual')}:{' '}
          {(['low', 'medium', 'high'] as const).map((b) => (
            <span key={b} style={{ marginLeft: 12 }}>{swatch(rgb(RESIDUAL_COLORS[b]))}{t(b === 'low' ? 'Low' : b === 'medium' ? 'Medium' : 'High')}</span>
          ))}
        </span>
      </div>
    </div>
  )
})
