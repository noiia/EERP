import type { Rgb, RiskRow } from './scoring'

// The AMDEC register as one table: what the Register tab shows, what its CSV/XLSX/PDF exports
// write, and what the Office "Risk register" object draws — one source for all of them.

export const REGISTER_HEADS = ['Risk', 'Category', 'Impact on', 'Likelihood', 'Severity', 'Detectability', 'Criticity', 'Remediation', 'Responsible', 'Deadline', 'Residual criticity']

export type RegisterCell = string | number | null
export interface RegisterTable {
  heads: string[]
  rows: RegisterCell[][]
  /** The temperature view: one row background per row (null = none), written by the XLSX and PDF exports. */
  fills?: (Rgb | null)[]
}

export function registerTable(
  rows: RiskRow[],
  categories: { id: string; name: string }[],
  responsible: (r: RiskRow) => string | undefined,
  t: (s: string) => string,
): RegisterTable {
  const cat = new Map(categories.map((c) => [c.id, c.name]))
  const impact: Record<string, string> = { delay: t('Delay'), cost: t('Cost'), quality: t('Quality') }
  return {
    heads: REGISTER_HEADS.map(t),
    rows: rows.map((r) => [
      r.name,
      (r.category_id && cat.get(r.category_id)) || null,
      impact[r.impact_on] ?? r.impact_on ?? null,
      r.likelihood ?? null,
      r.severity_note && r.severity_effective == null ? t('Not computable') : (r.severity_effective ?? null),
      r.detectability ?? null,
      r.criticity ?? null,
      r.remediation || null,
      (r.responsible_id && responsible(r)) || null,
      r.deadline ? r.deadline.slice(0, 10) : null,
      r.residual_criticity ?? null,
    ]),
  }
}
