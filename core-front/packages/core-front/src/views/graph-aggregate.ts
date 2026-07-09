// Pure aggregate/bucket math for Graph widgets (docs/roadmaps/list-view-modes.md,
// Phase 5). No React, no rendering — kept separate so the numbers are testable
// without mounting anything, and so widget components stay thin dispatchers
// over these functions.

export type NumericAggregate = 'sum' | 'avg' | 'mean' | 'count'
export type FullAggregate = NumericAggregate | 'median'

/** Coerce a record field value to a finite number, or null if it isn't one
 * (missing, non-numeric text, NaN/Infinity). */
export function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * sum / avg(=mean) / count / median over a list of numbers. Median SORTS for a
 * real middle value (or the average of the two middles on an even count) —
 * never an approximation (the roadmap's Phase 5 prompt calls this out
 * explicitly). Empty input aggregates to 0 for every kind except count.
 */
export function aggregate(values: number[], kind: FullAggregate): number {
  switch (kind) {
    case 'count':
      return values.length
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'avg':
    case 'mean':
      return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
    case 'median': {
      if (values.length === 0) return 0
      const sorted = [...values].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
    }
  }
}

export type BucketGranularity = 'day' | 'week' | 'month'

/**
 * Local-time bucket key for a stored 'YYYY-MM-DD' date value. Deliberately
 * NEVER `new Date('YYYY-MM-DD')` (parses as UTC midnight — the classic
 * off-by-one-local-day bug this codebase's Calendar renderer already avoids;
 * see the roadmap's Pitfalls). Returns null for a value that isn't a plain
 * date string — the caller skips it rather than guessing.
 * 'week' buckets to that ISO-ish week's Monday (a grouping key, not a full
 * ISO-8601 week-number implementation — see the roadmap's Pitfalls).
 */
export function bucketKey(value: string, granularity: BucketGranularity): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (granularity === 'day') return `${y}-${match[2]}-${match[3]}`
  if (granularity === 'month') return `${y}-${match[2]}`
  const date = new Date(y, m - 1, d)
  const dow = date.getDay() // 0=Sun..6=Sat
  date.setDate(date.getDate() + ((dow === 0 ? -6 : 1) - dow)) // back to Monday
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export interface XyPoint {
  bucket: string
  value: number
}

/** xy widget config: one point per bucket of `xField`, `yField` aggregated
 * within it. Records missing either field, or whose `xField` isn't a plain
 * date string, are skipped (not zero-filled). */
export function xyPoints<T>(
  records: T[],
  config: { xField: string; yField: string; aggregate: NumericAggregate; bucket: BucketGranularity },
): XyPoint[] {
  const groups = new Map<string, number[]>()
  for (const record of records) {
    const rawX = (record as Record<string, unknown>)[config.xField]
    if (typeof rawX !== 'string') continue
    const key = bucketKey(rawX, config.bucket)
    if (key == null) continue
    const y = toNumber((record as Record<string, unknown>)[config.yField])
    if (y == null) continue
    const bucketValues = groups.get(key) ?? []
    bucketValues.push(y)
    groups.set(key, bucketValues)
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) // 'YYYY-MM[-DD]' sorts chronologically as text
    .map(([bucket, values]) => ({ bucket, value: aggregate(values, config.aggregate) }))
}

export interface XySeries {
  /** Empty string for the implicit single-series case (no `seriesField`) —
   * callers treat an empty label as "don't show a legend", not a real group. */
  label: string
  points: XyPoint[]
}

/**
 * Like `xyPoints`, but splits `records` into one series per distinct value of
 * `seriesField` first (e.g. a status column), aggregating each independently
 * — a multi-line chart, one color per value. Records with no value in
 * `seriesField` are skipped, same posture as `pieSlices`' `groupByField`. No
 * `seriesField` ⇒ a single implicit series (empty label), identical to
 * calling `xyPoints` directly.
 */
export function xySeries<T>(
  records: T[],
  config: {
    xField: string
    yField: string
    aggregate: NumericAggregate
    bucket: BucketGranularity
    seriesField?: string
  },
): XySeries[] {
  if (!config.seriesField) {
    return [{ label: '', points: xyPoints(records, config) }]
  }
  const seriesField = config.seriesField
  const groups = new Map<string, T[]>()
  for (const record of records) {
    const raw = (record as Record<string, unknown>)[seriesField]
    if (raw == null || raw === '') continue
    const label = String(raw)
    const group = groups.get(label) ?? []
    group.push(record)
    groups.set(label, group)
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, groupRecords]) => ({ label, points: xyPoints(groupRecords, config) }))
}

export interface PieSlice {
  label: string
  /** Slice SIZE — always the record COUNT for this group. Two groups with the
   * same number of records always render as equally-sized slices, regardless
   * of `valueField` — grouping is a categorical split, not a value-weighted
   * one (a company with one $3 deal and a company with one $2 deal are each
   * "one company," not "3 parts vs 2 parts" of the pie). */
  count: number
  /** What the tooltip shows: `valueField`'s SUM for this group when
   * configured, otherwise the same as `count` (nothing else to show). Purely
   * a display annotation — never affects slice size. */
  displayValue: number
}

/** Sentinel label for the folded "everything past the palette's slot count"
 * slice — never a real group value, so widgets can localize it at render
 * time without guessing whether a group happens to be named "Other". */
export const OTHER_LABEL = ' other'

/** The categorical palette has this many hue slots (docs/roadmaps/
 * list-view-modes.md cites dataviz's validated 8-hue palette) — a 9th
 * distinct group folds into OTHER_LABEL rather than reusing a hue. */
export const MAX_PIE_SLICES = 8

/**
 * pie widget config: one EQUALLY-SIZED-BY-DEFAULT slice per distinct
 * `groupByField` value — size is always the group's record count, so a pie
 * is always "what share of records fall in each group," never accidentally
 * value-weighted. `valueField` (optional) adds a displayed SUM per slice
 * (the tooltip), independent of sizing — picking one field to group by and a
 * different field to also show never secretly changes which slice is
 * bigger. Slices beyond MAX_PIE_SLICES-1 fold into one OTHER_LABEL slice,
 * ranked by count so the folded slices are always the smallest groups.
 */
export function pieSlices<T>(records: T[], config: { groupByField: string; valueField?: string }): PieSlice[] {
  const groups = new Map<string, { count: number; sum: number }>()
  for (const record of records) {
    const raw = (record as Record<string, unknown>)[config.groupByField]
    if (raw == null || raw === '') continue
    const label = String(raw)
    const entry = groups.get(label) ?? { count: 0, sum: 0 }
    entry.count += 1
    if (config.valueField) {
      const v = toNumber((record as Record<string, unknown>)[config.valueField])
      if (v != null) entry.sum += v
    }
    groups.set(label, entry)
  }
  const slices = Array.from(groups.entries())
    .map(([label, { count, sum }]) => ({ label, count, displayValue: config.valueField ? sum : count }))
    .sort((a, b) => b.count - a.count)
  if (slices.length <= MAX_PIE_SLICES) return slices
  const kept = slices.slice(0, MAX_PIE_SLICES - 1)
  const folded = slices.slice(MAX_PIE_SLICES - 1)
  const foldedCount = folded.reduce((total, s) => total + s.count, 0)
  const foldedDisplay = folded.reduce((total, s) => total + s.displayValue, 0)
  return [...kept, { label: OTHER_LABEL, count: foldedCount, displayValue: foldedDisplay }]
}

/** stat widget config: one aggregate over `field` (or record count, for
 * `count`, which ignores `field` entirely — "how many records" needs no
 * field). Non-numeric values are skipped for mean/median/sum, same as xy/pie. */
export function statValue<T>(records: T[], config: { field: string; aggregate: FullAggregate }): number {
  if (config.aggregate === 'count') return records.length
  const values = records
    .map((r) => toNumber((r as Record<string, unknown>)[config.field]))
    .filter((v): v is number => v != null)
  return aggregate(values, config.aggregate)
}

/**
 * "Nice" (1/2/5 × 10^n) Y-axis tick values from 0 up to at least `max`,
 * aiming for roughly `targetCount` gridlines — the same rounding families
 * every off-the-shelf chart axis uses, so ticks read as 0/1/2/3/4 or
 * 0/5/10/15/20, never 0/1.37/2.74/…. `max <= 0` still returns a single [0]
 * tick rather than dividing by zero.
 */
export function niceTicks(max: number, targetCount = 4): number[] {
  if (max <= 0) return [0]
  const roughStep = max / targetCount
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const residual = roughStep / magnitude
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude
  const ticks: number[] = []
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}
