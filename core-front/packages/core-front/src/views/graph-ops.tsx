'use client'
import { createContext, useContext, type ReactNode } from 'react'
import type { GraphLayout, Tile } from '../api/graph'

// How GraphRenderer reaches the Graph mode tile layout (docs/roadmaps/
// list-view-modes.md, Phase 4). Same shape as RelationOps: the functions are
// bound Server Action references the host provides once (root layout) —
// client code never talks to Go directly, and Go authorizes every call from
// the session (permission derives from the /settings/views/:entity/graph
// route). Kept as its own context, not folded into RelationOps, because it
// reaches SETTINGS state (per-entity, admin-configured — ADR-006), not
// another entity's records.

export type GraphSaveResult = { ok: true } | { ok: false; message: string }

export interface GraphOps {
  get: (entity: string) => Promise<GraphLayout>
  save: (entity: string, tiles: Tile[]) => Promise<GraphSaveResult>
}

const GraphOpsContext = createContext<GraphOps | null>(null)

/** Host wiring: mount once (root layout) with bound Server Action references. */
export function GraphOpsProvider({ ops, children }: { ops: GraphOps; children: ReactNode }) {
  return <GraphOpsContext.Provider value={ops}>{children}</GraphOpsContext.Provider>
}

/**
 * GraphRenderer's data path. Null when the host mounted no provider —
 * Graph mode renders an inert "not available" message instead of crashing,
 * the same posture RelationOps takes for a host with no relation wiring.
 */
export function useGraphOps(): GraphOps | null {
  return useContext(GraphOpsContext)
}
