import { useEffect, useState } from 'react'
import type { Tile } from '../api/graph'
import type { EntityListOptions } from '../api/list-options'
import { pinnedId } from '../api/view-fields'
import type { ServerTileData, ServerTileState } from './graph-server'
import { useRelationOps } from './relation-ops'

/** A stat or pie tile reading one figure a module computes for the record the list is
 * filtered on, instead of aggregating the list's rows: `GET /{scopeEntity}/<pin>/{path}`
 * answers `{<key>: number | null | {label, value, color?}[]}` (Project's
 * `/project/:id/indicators`). Lives in the tile's `config.source`. */
export interface TileSource {
  scopeField: string
  scopeEntity: string
  path: string
  key: string
  /** Shown after a stat's number ("%", "h", "d"). */
  unit?: string
  /** msgid naming the scope in the "filter on one …" hint (default: scopeEntity). */
  scopeLabel?: string
}

export function tileSource(tile: Tile): TileSource | null {
  const src = (tile.config as { source?: Partial<TileSource> } | null)?.source
  return src && src.scopeField && src.scopeEntity && src.path && src.key ? (src as TileSource) : null
}

type Indicators = Record<string, unknown>
// Every tile of one layout reads the same answer: one request per scope and path.
// shortcut: a 30 s in-memory cache, not invalidated by writes; upgrade to the
// entity refresh store if stale tiles become a complaint.
const CACHE_MS = 30_000
const cache = new Map<string, { at: number; read: Promise<Indicators> }>()

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

/** One indicator as the data a stat (`stat`, null = none) or pie (`slices`) draws. */
export function indicatorTileData(data: Indicators | null, key: string): ServerTileData {
  const v = data?.[key]
  if (Array.isArray(v)) {
    return {
      slices: v.map((s: { label?: unknown; value?: unknown; color?: unknown }) => {
        const n = Number(s.value) || 0
        return { label: String(s.label ?? ''), count: n, displayValue: n, ...(isHex(s.color) ? { color: s.color } : {}) }
      }),
    }
  }
  return { stat: typeof v === 'number' && Number.isFinite(v) ? v : null }
}

/** undefined: not a sourced tile. 'unpinned': the list isn't filtered on one scope record. */
export function useIndicatorTileData(tile: Tile, listOptions: EntityListOptions | undefined): ServerTileState | 'unpinned' {
  const src = tileSource(tile)
  const ops = useRelationOps()
  const pin = src ? pinnedId(listOptions, src.scopeField) : null
  const key = src && pin && ops ? `${src.scopeEntity}/${pin}/${src.path}` : ''
  const [state, setState] = useState<{ key: string; data: Indicators | null }>({ key: '', data: null })
  useEffect(() => {
    if (!key || !src || !pin || !ops) return
    let hit = cache.get(key)
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      hit = { at: Date.now(), read: ops.get(src.scopeEntity, `${pin}/${src.path}`) as Promise<Indicators> }
      hit.read.catch(() => cache.delete(key))
      cache.set(key, hit)
    }
    let cancelled = false
    hit.read.then(
      (data) => !cancelled && setState({ key, data }),
      () => !cancelled && setState({ key, data: null }),
    )
    return () => {
      cancelled = true
    }
    // key captures scope, pin and path.
  }, [key])
  if (!src) return undefined
  if (!pin) return 'unpinned'
  if (!key) return indicatorTileData(null, src.key)
  return state.key === key ? indicatorTileData(state.data, src.key) : 'loading'
}

/** Test seam: forget cached answers. */
export function clearIndicatorCache() {
  cache.clear()
}
