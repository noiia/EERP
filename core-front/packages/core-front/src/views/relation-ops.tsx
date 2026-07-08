'use client'
import { createContext, useContext, type ReactNode } from 'react'
import type { EntityListOptions } from '../api/list-options'

// How relation widgets reach OTHER entities' data. The functions are bound
// Server Action references the host provides once (root layout) — client code
// never talks to Go, and Go authorizes every call from the session (the
// autocomplete only ever surfaces records the user may read). Kept apart from
// EntityActions on purpose: those are the view's own entity, pre-bound; these
// are entity-generic, for the entities relation fields point at.

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
}

const RelationOpsContext = createContext<RelationOps | null>(null)

/** Host wiring: mount once (root layout) with bound Server Action references. */
export function RelationOpsProvider({
  ops,
  children,
}: {
  ops: RelationOps
  children: ReactNode
}) {
  return <RelationOpsContext.Provider value={ops}>{children}</RelationOpsContext.Provider>
}

/**
 * The relation widgets' data path. Null when the host mounted no provider —
 * widgets render an inert affordance instead of crashing (a host without
 * relation wiring simply has no live relation fields).
 */
export function useRelationOps(): RelationOps | null {
  return useContext(RelationOpsContext)
}
