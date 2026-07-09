import type { JsonValue } from '../views/descriptor'

// Graph display mode's tile layout (docs/roadmaps/list-view-modes.md, Phase 4).
// Client-safe (no 'server-only' import) — GraphOps (graph-ops.tsx) and the
// shell's bound Server Actions both need these types.

/** One grid unit, in px. The ONE place this number is allowed to be a bare
 * literal — every drag/resize/CSS computation imports this constant instead. */
export const GRID_UNIT = 30

export type TileType = 'xy' | 'pie' | 'stat' | 'list'

export const TILE_TYPES: readonly TileType[] = ['xy', 'pie', 'stat', 'list']

/**
 * A Graph canvas tile. `x`/`y`/`w`/`h` are integer GRID_UNIT multiples, not
 * pixels. `config` is a closed, per-`type` JSON shape (Phase 5 defines each
 * one) — pure data, no functions, the same RSC-boundary rule every other
 * descriptor-shaped thing in this codebase follows.
 */
export interface Tile {
  id: string
  x: number
  y: number
  w: number
  h: number
  type: TileType
  title?: string
  config: JsonValue
}

export interface GraphLayout {
  tiles: Tile[]
}

export const EMPTY_GRAPH_LAYOUT: GraphLayout = { tiles: [] }
