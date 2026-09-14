'use client'
import { createOpsContext } from './ops-context'
import type { FilterCondition } from './descriptor'

// How the search bar (search-bar.tsx) reaches named, reusable filter
// combinations (docs/adr/ADR-014-search-filter-bar.md) — a user builds a set
// of filters/group-by in one entity's search bar and saves it under a name,
// private or shared. Kept as its own context, not folded into RelationOps,
// because these are independent named ROWS a user creates/renames/deletes —
// the same shape NotebookOps already takes for a record's own pages, unlike
// GraphOps's single-blob-per-entity shape. See ops-context.tsx for the
// shared wiring contract.

export interface SavedFilterConfig {
  filters: FilterCondition[]
  groupBy?: string
}

export interface SavedFilterRecord {
  id: string
  entity: string
  name: string
  shared: boolean
  /** Whether the CALLER owns this row — only an owner can rename/delete it,
   * even when it's shared. The backend enforces this independently. */
  mine: boolean
  config: SavedFilterConfig
}

export interface SavedFilterOps {
  /** Every filter the caller may use on this entity's search bar: their own
   * (private or shared) plus every other user's shared filter. */
  list: (entity: string) => Promise<SavedFilterRecord[]>
  create: (
    entity: string,
    name: string,
    shared: boolean,
    config: SavedFilterConfig,
  ) => Promise<SavedFilterRecord>
  update: (
    id: string,
    patch: { name: string; shared: boolean; config: SavedFilterConfig },
  ) => Promise<SavedFilterRecord>
  remove: (id: string) => Promise<void>
}

const savedFilterOpsContext = createOpsContext<SavedFilterOps>()

/** Host wiring: mount once (root layout) with bound Server Action references. */
export const SavedFilterOpsProvider = savedFilterOpsContext.Provider

/** The search bar's saved-filters data path — null when the host mounted no provider. */
export const useSavedFilterOps = savedFilterOpsContext.useOps
