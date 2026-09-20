'use client'
import type { GraphField, GraphFieldDraft, GraphLayout, Tile } from '../api/graph'
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
  /** Calculated fields (optional: a host without them just shows none). */
  listFields?: (entity: string) => Promise<GraphField[]>
  createField?: (entity: string, draft: GraphFieldDraft) => Promise<GraphSaveResult>
  /** Edit label/formula/roles/dated (the key is immutable). */
  updateField?: (id: string, draft: Omit<GraphFieldDraft, 'key'>) => Promise<GraphSaveResult>
  /** Hard delete — tiles that used it then read 0. */
  deleteField?: (id: string) => Promise<GraphSaveResult>
}

const graphOpsContext = createOpsContext<GraphOps>()

/** Host wiring: mount once (root layout) with bound Server Action references. */
export const GraphOpsProvider = graphOpsContext.Provider

/** GraphRenderer's data path — null when the host mounted no provider. */
export const useGraphOps = graphOpsContext.useOps
