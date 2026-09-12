'use client'
import type { GraphLayout, Tile } from '../api/graph'
import { createOpsContext } from './ops-context'

// How GraphRenderer reaches the Graph mode tile layout (docs/roadmaps/
// list-view-modes.md, Phase 4). Kept as its own context, not folded into
// RelationOps, because it reaches SETTINGS state (per-entity, admin-configured —
// ADR-006), not another entity's records. See ops-context.tsx for the shared
// wiring contract.

export type GraphSaveResult = { ok: true } | { ok: false; message: string }

export interface GraphOps {
  get: (entity: string) => Promise<GraphLayout>
  save: (entity: string, tiles: Tile[]) => Promise<GraphSaveResult>
}

const graphOpsContext = createOpsContext<GraphOps>()

/** Host wiring: mount once (root layout) with bound Server Action references. */
export const GraphOpsProvider = graphOpsContext.Provider

/** GraphRenderer's data path — null when the host mounted no provider. */
export const useGraphOps = graphOpsContext.useOps
