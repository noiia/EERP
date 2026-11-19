'use server'
import {
  ApiError,
  apiRequest,
  createServerApiClient,
  settleAction,
  type ActionError,
  type EntityListOptions,
} from '@eerp/core-front/server'
import type { RelationRecord, ViewLayout } from '@eerp/core-front'

// Entity-generic Server Actions backing the engine's RelationOps: how relation
// widgets (client) query and link OTHER entities — autocomplete search, o2m
// scoping, junction reads/writes. Always through the BFF ApiClient, so Go
// authorizes each call from the session (permission derives from the entity
// route). Mounted once app-wide by the root layout's RelationOpsProvider.

export async function listRecords(
  entity: string,
  options?: EntityListOptions,
): Promise<RelationRecord[] | ActionError> {
  return settleAction(() => createServerApiClient().list<RelationRecord>(entity, options))
}

export async function listRecordsPage(
  entity: string,
  options?: EntityListOptions,
): Promise<{ records: RelationRecord[]; total: number; totalEstimated?: true } | ActionError> {
  return settleAction(() => createServerApiClient().listWithTotal<RelationRecord>(entity, options))
}

export async function getRecord(entity: string, id: string): Promise<RelationRecord | ActionError> {
  return settleAction(() => createServerApiClient().get<RelationRecord>(entity, id))
}

export async function createRelationRecord(
  entity: string,
  body: Record<string, unknown>,
): Promise<RelationRecord | ActionError> {
  return settleAction(() => createServerApiClient().create<RelationRecord>(entity, body))
}

export async function updateRelationRecord(
  entity: string,
  id: string,
  body: Record<string, unknown>,
): Promise<RelationRecord | ActionError> {
  return settleAction(() => createServerApiClient().update<RelationRecord>(entity, id, body))
}

export async function removeRelationRecord(entity: string, id: string): Promise<void | ActionError> {
  return settleAction(() => createServerApiClient().remove(entity, id))
}

export async function distinctValues(
  entity: string,
  column: string,
  options?: EntityListOptions,
): Promise<{ value: string; total: number }[] | ActionError> {
  return settleAction(() => createServerApiClient().distinctValues(entity, column, options))
}

// A Server Action can be called with any string.
const isLayoutMode = (m: string) => m === 'wbs' || m === 'pert'

export async function getViewLayout(entity: string, mode: 'wbs' | 'pert'): Promise<ViewLayout> {
  if (!isLayoutMode(mode)) return { positions: {}, folded: [] }
  try {
    const l = await apiRequest<Partial<ViewLayout>>('GET', `/me/view_layout/${encodeURIComponent(entity)}/${mode}`)
    return { positions: l.positions ?? {}, folded: l.folded ?? [], notes: l.notes ?? [] }
  } catch {
    return { positions: {}, folded: [] }
  }
}

export async function saveViewLayout(
  entity: string,
  mode: 'wbs' | 'pert',
  layout: ViewLayout,
): Promise<void | ActionError> {
  // settleAction's value is rethrown as an ApiError by RelationOpsProvider (unwrapActions).
  return settleAction(async () => {
    if (!isLayoutMode(mode)) throw new ApiError({ code: 'VALIDATION_ERROR', message: 'Unknown view mode.', status: 400 })
    await apiRequest('PUT', `/me/view_layout/${encodeURIComponent(entity)}/${mode}`, layout)
  })
}
