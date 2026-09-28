'use client'
import { useEffect, useState } from 'react'
import type { GraphAggregateRequest, GraphAggregateRow, Tile } from '../api/graph'
import type { EntityListOptions } from '../api/list-options'
import {
  calcKeysIn,
  expandCalcFormula,
  seriesFromCells,
  slicesFromCells,
  type CalcField,
  type PieSlice,
  type XySeries,
} from './graph-aggregate'
import type { GraphOps } from './graph-ops'

// Graph tiles aggregated by Go over EVERY matching row
// (docs/adr/ADR-023-graph-server-aggregation.md) instead of the fetched page.
// planTile turns a tile's config into GET ?aggregate= requests and says how
// to reassemble the answers into the exact shapes the widgets already draw
// (XySeries[], PieSlice[], a stat number) — so widgets don't care where the
// numbers came from.

/** What a server-aggregated tile renders from. */
export interface ServerTileData {
  series?: XySeries[]
  slices?: PieSlice[]
  stat?: number
}

export interface TilePlan {
  requests: GraphAggregateRequest[]
  assemble: (results: GraphAggregateRow[][]) => ServerTileData
}

type Numeric = 'sum' | 'avg' | 'mean' | 'count' | 'median'

/**
 * The server plan for a tile, or null when it must stay client-side: list
 * tiles (already server-filtered), incomplete configs, and tiles using a
 * DATED calculated field (computed per child row — expandByChildren — which
 * the per-table aggregate can't express).
 *
 * `isNumber(field)` says whether a field is numeric (descriptor number
 * fields and calc_ fields): a `count` over a non-numeric field counts rows,
 * since Go only aggregates numeric expressions.
 */
export function planTile(
  tile: Tile,
  calcFields: CalcField[],
  isNumber: (field: string) => boolean,
  labelOf: (field: string) => string,
): TilePlan | null {
  const cfg = (tile.config ?? {}) as Record<string, unknown>
  const dated = new Set(calcFields.filter((f) => f.dated).map((f) => f.key))
  if (calcKeysIn([cfg]).some((k) => dated.has(k))) return null
  const value = (field: string | undefined, agg: Numeric): string | undefined => {
    if (!field) return undefined
    if (agg === 'count' && !isNumber(field)) return undefined
    return expandCalcFormula(field, calcFields)
  }
  const str = (k: string) => (typeof cfg[k] === 'string' && cfg[k] !== '' ? (cfg[k] as string) : undefined)

  switch (tile.type) {
    case 'stat': {
      const field = str('field')
      const agg = str('aggregate') as Numeric | undefined
      if (!field || !agg) return null
      // A stat count is "how many records" — never a per-field count.
      const req: GraphAggregateRequest = agg === 'count' ? { aggregate: 'count' } : { aggregate: agg, value: value(field, agg) }
      return { requests: [req], assemble: ([rows]) => ({ stat: rows?.[0]?.value ?? 0 }) }
    }
    case 'xy':
    case 'bar': {
      const x = str('xField')
      const y = str('yField')
      const agg = str('aggregate') as Numeric | undefined
      const bucket = str('bucket') as GraphAggregateRequest['bucket']
      if (!x || !y || !agg || !bucket) return null
      const series = str('seriesField')
      const yFields = Array.isArray(cfg.yFields) ? (cfg.yFields as string[]) : []
      if (!series && yFields.length > 1) {
        return {
          requests: yFields.map((f) => ({ aggregate: agg, value: value(f, agg), x, bucket })),
          assemble: (results) => ({
            series: yFields.map((f, i) => ({ label: labelOf(f), points: seriesFromCells(results[i] ?? [])[0]?.points ?? [] })),
          }),
        }
      }
      return {
        requests: [{ aggregate: agg, value: value(y, agg), x, bucket, group: series }],
        assemble: ([rows]) => ({ series: series ? seriesFromCells(rows ?? []) : seriesFromCells(rows ?? []).slice(0, 1) }),
      }
    }
    case 'pie': {
      const group = str('groupByField')
      if (!group) return null
      const valueField = str('valueField')
      return {
        requests: [valueField ? { aggregate: 'sum', value: value(valueField, 'sum'), group } : { aggregate: 'count', group }],
        assemble: ([rows]) => ({ slices: slicesFromCells(rows ?? [], Boolean(valueField)) }),
      }
    }
    default:
      return null
  }
}

/** Per-tile server data: undefined = client path (no plan, no host support,
 * or a failed request — the widget then aggregates the fetched page as
 * before), 'loading' while Go answers. */
export type ServerTileState = ServerTileData | 'loading' | undefined

/**
 * Runs a tile's plan through GraphOps.aggregate, re-running when the plan or
 * the active list filters change. A failed/unsupported call degrades to the
 * client path rather than an error — the old behavior, badge included.
 */
export function useServerTileData(
  entity: string,
  plan: TilePlan | null,
  graphOps: GraphOps | null,
  listOptions: EntityListOptions | undefined,
): ServerTileState {
  const aggregate = graphOps?.aggregate
  const key = plan && aggregate ? JSON.stringify([entity, plan.requests, listOptions ?? null]) : ''
  const [state, setState] = useState<{ key: string; data: ServerTileState }>({ key: '', data: undefined })
  useEffect(() => {
    if (!key || !plan || !aggregate) return
    let cancelled = false
    Promise.all(plan.requests.map((req) => aggregate(entity, req, listOptions))).then(
      (results) => {
        if (cancelled) return
        const failed = results.some((r) => r == null)
        setState({ key, data: failed ? undefined : plan.assemble(results as GraphAggregateRow[][]) })
      },
      () => !cancelled && setState({ key, data: undefined }),
    )
    return () => {
      cancelled = true
    }
    // key captures entity + requests + filters; plan/aggregate identity churns per render.
  }, [key])
  if (!key) return undefined
  return state.key === key ? state.data : 'loading'
}
