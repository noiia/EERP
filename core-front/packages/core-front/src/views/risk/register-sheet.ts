import { band, heatColors, tint, type Rgb, type RiskRow } from './scoring'

// The register's PNG/PDF sheet: one fixed, light-only layout (#, risk, remediation, if it happens,
// criticity, residual) drawn by the PNG view (register-sheet-view.tsx) and the PDF writer alike.
// Colors never follow the ERP theme: an exported register always reads on white.

export const SHEET_HEADER: Rgb = [14, 59, 71]
export const SHEET_INK: Rgb = [30, 41, 59]
export const SHEET_LINE: Rgb = [255, 255, 255]
export const RESIDUAL_COLORS: Record<'low' | 'medium' | 'high', Rgb> = {
  low: [168, 222, 190],
  medium: [250, 229, 150],
  high: [245, 183, 177],
}
export const SHEET_HEADS = ['#', 'Risk', 'Remediation', 'If it happens', 'Criticity', 'Residual']
/** Relative column widths. */
export const SHEET_WIDTHS = [0.6, 3, 3.2, 3.2, 1.2, 1.2]

export interface SheetRow {
  num: string
  cells: [string, string, string, string, string, string]
  /** Fills: the # cell (the heat color), the text cells, the criticity cell, the residual cell. */
  num_fill: Rgb | null
  body_fill: Rgb | null
  criticity_fill: Rgb | null
  residual_fill: Rgb | null
}

export interface Sheet {
  rows: SheetRow[]
  /** The criticity range the colors span (null when no risk has one): the legend's ends. */
  range: [number, number] | null
}

const dash = (v: unknown) => (v == null || v === '' ? '—' : String(v))

/** The sheet of `rows`, in their order (R1 first); heat colors relative to these rows only. */
export function registerSheet(rows: RiskRow[]): Sheet {
  const heat = heatColors(rows.map((r) => r.criticity))
  const known = rows.map((r) => r.criticity).filter((c): c is number => c != null)
  return {
    range: known.length ? [Math.min(...known), Math.max(...known)] : null,
    rows: rows.map((r, i) => {
      const c = heat[i]
      const b = band(r.residual_criticity)
      const num = `R${i + 1}`
      return {
        num,
        cells: [num, r.name, dash(r.remediation), dash(r.if_it_happens), dash(r.criticity), dash(r.residual_criticity)],
        num_fill: c,
        body_fill: c && tint(c, 0.85),
        criticity_fill: c && tint(c, 0.45),
        residual_fill: b && RESIDUAL_COLORS[b],
      }
    }),
  }
}

/** A cell's fill by column index. */
export function cellFill(row: SheetRow, col: number): Rgb | null {
  return col === 0 ? row.num_fill : col === 4 ? row.criticity_fill : col === 5 ? row.residual_fill : row.body_fill
}

/** `n` evenly spaced colors of the heat scale, low to high: the legend's gradient. */
export const legendScale = (n = 12): Rgb[] => heatColors(Array.from({ length: n }, (_, i) => i)) as Rgb[]

export const rgb = (c: Rgb) => `rgb(${c.join(',')})`
