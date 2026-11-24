export type Band = 'low' | 'medium' | 'high'
export const RISK_LIKELIHOODS = [3, 2, 1] as const
export const RISK_SEVERITIES = [1, 2, 3, 4] as const

export interface RiskRow {
  id: string
  name: string
  category_id: string | null
  impact_on: string
  likelihood: number | null
  severity?: number | null
  severity_effective: number | null
  detectability?: number | null
  criticity: number | null
  residual_likelihood: number | null
  residual_severity: number | null
  residual_detectability?: number | null
  residual_criticity: number | null
  severity_note: string | null
  remediation?: string | null
  if_it_happens?: string | null
  responsible_id?: string | null
  deadline?: string | null
}

// Criticity bands (likelihood × severity × detectability): the same cut-offs as the Go side.
export function band(criticity: number | null): Band | null {
  if (criticity == null) return null
  return criticity <= 4 ? 'low' : criticity <= 12 ? 'medium' : 'high'
}

/** Rows by matrix cell `${likelihood}:${severity}`, current or residual; a row missing either score is left out. */
export function matrixCells(rows: RiskRow[], residual: boolean): Map<string, RiskRow[]> {
  const cells = new Map<string, RiskRow[]>()
  for (const r of rows) {
    const l = residual ? r.residual_likelihood : r.likelihood
    const s = residual ? r.residual_severity : r.severity_effective
    if (l == null || s == null) continue
    const k = `${l}:${s}`
    cells.set(k, [...(cells.get(k) ?? []), r])
  }
  return cells
}

const byCriticity = (a: RiskRow, b: RiskRow) => (b.criticity ?? -1) - (a.criticity ?? -1)

/** One Ishikawa bone per category (name order), an uncategorized one last when any risk has no known category. */
export function ishikawaBones(rows: RiskRow[], categories: { id: string; name: string }[]) {
  const known = new Set(categories.map((c) => c.id))
  const bones: { id: string | null; name: string; risks: RiskRow[] }[] = [...categories]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ id: c.id, name: c.name, risks: rows.filter((r) => r.category_id === c.id).sort(byCriticity) }))
  const rest = rows.filter((r) => !r.category_id || !known.has(r.category_id)).sort(byCriticity)
  if (rest.length) bones.push({ id: null, name: 'Uncategorized', risks: rest })
  return bones
}

export type Rgb = [number, number, number]

/** The register's temperature colors, relative to the listed risks: the lowest criticity of the list is
 * green, the highest red (yellow and orange between), so the most dangerous risk listed is always red.
 * A list with one distinct criticity is all red. No criticity, no color. */
export function heatColors(criticities: (number | null)[]): (Rgb | null)[] {
  const known = criticities.filter((c): c is number => c != null)
  const min = Math.min(...known)
  const max = Math.max(...known)
  return criticities.map((c) => {
    if (c == null) return null
    const t = max === min ? 1 : (c - min) / (max - min)
    // HSL(hue, 65%, 50%) to RGB, hue 130 (green) -> 0 (red): muted, so dark text reads on every step.
    const h = 130 * (1 - t)
    const f = (n: number) => {
      const k = (n + h / 30) % 12
      return Math.round(255 * (0.5 - 0.325 * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
    }
    return [f(0), f(8), f(4)]
  })
}

/** `c` blended with white (`amount` 0 = c, 1 = white): the readable row tint of the exports. */
export const tint = ([r, g, b]: Rgb, amount = 0.65): Rgb => [r, g, b].map((v) => Math.round(v + (255 - v) * amount)) as Rgb
