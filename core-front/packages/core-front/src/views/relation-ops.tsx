'use client'
import type { EntityListOptions } from '../api/list-options'
import { createOpsContext } from './ops-context'

// How relation widgets reach OTHER entities' data. Kept apart from EntityActions on
// purpose: those are the view's own entity, pre-bound; these are entity-generic, for
// the entities relation fields point at. See ops-context.tsx for the shared wiring
// contract (host provides bound Server Actions once; null with no provider is inert).

/** Related records are opaque to the engine beyond their id. */
export interface RelationRecord {
  id: string
  [key: string]: unknown
}

export interface RelationOps {
  list: (entity: string, options?: EntityListOptions) => Promise<RelationRecord[]>
  get: (entity: string, id: string) => Promise<RelationRecord>
  /** Junction-row creation (m2m link). Go re-authorizes the POST per route. */
  create: (entity: string, body: Record<string, unknown>) => Promise<RelationRecord>
  /** Junction-row removal (m2m unlink). */
  remove: (entity: string, id: string) => Promise<void>
  /**
   * The search bar's group-by section (docs/adr/ADR-014-search-filter-bar.md):
   * every distinct value of column (+ count) among rows matching options'
   * filters. Optional and fail-open (undefined, not a rejected promise) for
   * a host that hasn't wired the Server Action yet — same posture the
   * field-level group-gating client mirror takes.
   */
  distinctValues?: (
    entity: string,
    column: string,
    options?: EntityListOptions,
  ) => Promise<{ value: string; total: number }[]>
}

const relationOpsContext = createOpsContext<RelationOps>()

/** Host wiring: mount once (root layout) with bound Server Action references. */
export const RelationOpsProvider = relationOpsContext.Provider

/** The relation widgets' data path — null when the host mounted no provider. */
export const useRelationOps = relationOpsContext.useOps
