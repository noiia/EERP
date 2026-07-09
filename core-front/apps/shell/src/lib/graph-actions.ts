'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'
import { EMPTY_GRAPH_LAYOUT, type GraphLayout, type Tile } from '@eerp/core-front'
import type { GraphSaveResult } from '@eerp/core-front'

// Entity-generic Server Actions backing the engine's GraphOps: how
// GraphRenderer (client) reads and saves a Graph mode tile layout
// (docs/roadmaps/list-view-modes.md, Phase 4). Always through the BFF
// apiRequest helper, so Go authorizes each call from the session (permission
// derives from the /settings/views/:entity/graph route). Mounted once
// app-wide by the root layout's GraphOpsProvider, mirroring RelationOps.

/**
 * Read entity's saved Graph layout. Degrades to an empty canvas on any
 * failure (missing settings:views:read, session hiccup) rather than
 * throwing — GraphRenderer then just shows a blank canvas.
 */
export async function getEntityGraphLayout(entity: string): Promise<GraphLayout> {
  try {
    return await apiRequest<GraphLayout>('GET', `/settings/views/${entity}/graph`)
  } catch {
    return EMPTY_GRAPH_LAYOUT
  }
}

/**
 * Save entity's Graph layout. Go authorizes: callers without
 * settings:views:write get the error envelope back as a message.
 */
export async function setEntityGraphLayout(entity: string, tiles: Tile[]): Promise<GraphSaveResult> {
  try {
    await apiRequest('PUT', `/settings/views/${entity}/graph`, { tiles })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : 'Could not save the graph layout.' }
  }
}
