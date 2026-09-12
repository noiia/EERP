'use server'
import { apiRequest } from '@eerp/core-front/server'
import type { SavedFilterConfig, SavedFilterRecord } from '@eerp/core-front'

// Entity-generic Server Actions backing the engine's SavedFilterOps: how the
// search bar (client) lists/creates/updates/removes named filter
// combinations (docs/adr/ADR-014-search-filter-bar.md). Always through the
// BFF apiRequest helper — never the generic entity ApiClient, since
// saved_filter is a dedicated, owner-scoped resource off the generic CRUD
// surface (permission derives from the /saved_filters route). Mounted once
// app-wide by the root layout's SavedFilterOpsProvider, mirroring NotebookOps.

interface SavedFilterDTO {
  id: string
  entity: string
  name: string
  shared: boolean
  config: string
  mine: boolean
}

function fromDTO(dto: SavedFilterDTO): SavedFilterRecord {
  let config: SavedFilterConfig = { filters: [] }
  try {
    config = JSON.parse(dto.config) as SavedFilterConfig
  } catch {
    // A malformed stored blob degrades to "no filters" rather than breaking
    // the whole search bar — same posture app_settings' Kanban/Graph config
    // reads already take on unparseable JSON.
  }
  return { id: dto.id, entity: dto.entity, name: dto.name, shared: dto.shared, mine: dto.mine, config }
}

export async function listSavedFilters(entity: string): Promise<SavedFilterRecord[]> {
  const res = await apiRequest<{ data: SavedFilterDTO[] }>(
    'GET',
    `/saved_filters?entity=${encodeURIComponent(entity)}`,
  )
  return res.data.map(fromDTO)
}

export async function createSavedFilter(
  entity: string,
  name: string,
  shared: boolean,
  config: SavedFilterConfig,
): Promise<SavedFilterRecord> {
  const dto = await apiRequest<SavedFilterDTO>('POST', '/saved_filters', {
    entity,
    name,
    shared,
    config: JSON.stringify(config),
  })
  return fromDTO(dto)
}

export async function updateSavedFilter(
  id: string,
  patch: { name: string; shared: boolean; config: SavedFilterConfig },
): Promise<SavedFilterRecord> {
  const dto = await apiRequest<SavedFilterDTO>('PUT', `/saved_filters/${id}`, {
    name: patch.name,
    shared: patch.shared,
    config: JSON.stringify(patch.config),
  })
  return fromDTO(dto)
}

export async function removeSavedFilter(id: string): Promise<void> {
  await apiRequest<void>('DELETE', `/saved_filters/${id}`)
}
