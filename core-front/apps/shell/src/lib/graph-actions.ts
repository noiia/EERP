'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'
import { EMPTY_GRAPH_LAYOUT, type GraphField, type GraphFieldDraft, type GraphLayout, type Tile } from '@eerp/core-front'
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

/** Calculated fields the caller's roles may see (Go filters by role). */
export async function listEntityGraphFields(entity: string): Promise<GraphField[]> {
  try {
    const res = await apiRequest<{ data: GraphField[] }>('GET', `/graph_fields?entity=${encodeURIComponent(entity)}`)
    return res.data
  } catch {
    return []
  }
}

export async function createEntityGraphField(entity: string, draft: GraphFieldDraft): Promise<GraphSaveResult> {
  try {
    await apiRequest('POST', '/graph_fields', { entity, ...draft })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : 'Could not create the field.' }
  }
}

export async function deleteEntityGraphField(id: string): Promise<GraphSaveResult> {
  try {
    await apiRequest('DELETE', `/graph_fields/${id}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : 'Could not delete the field.' }
  }
}

export async function updateEntityGraphField(id: string, draft: Omit<GraphFieldDraft, 'key'>): Promise<GraphSaveResult> {
  try {
    await apiRequest('PUT', `/graph_fields/${id}`, draft)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : 'Could not update the field.' }
  }
}
