'use client'
import { createOpsContext } from './ops-context'

// How the chatter panel (chatter-panel.tsx) reaches a record's activity feed —
// per-RECORD data, not per-entity settings, so its own context rather than
// folded into GraphOps, the exact same reasoning notebook-ops.tsx already
// gives for its own split. See ops-context.tsx for the shared wiring contract.

export interface ChatterMessageRecord {
  id: string
  author: string
  /** "message" (posted from the composer) or "log" (the form's own summary
   * of an edit) — both render as "author : body", the log ones styled muted. */
  kind: 'message' | 'log'
  body: string
  createdAt: string
}

export interface ChatterOps {
  /** Newest first — the feed reads top-down from "most recent". */
  list: (table: string, recordId: string) => Promise<ChatterMessageRecord[]>
  create: (
    table: string,
    recordId: string,
    kind: ChatterMessageRecord['kind'],
    body: string,
  ) => Promise<ChatterMessageRecord>
}

const chatterOpsContext = createOpsContext<ChatterOps>()

/** Host wiring: mount once (root layout) with bound Server Action references. */
export const ChatterOpsProvider = chatterOpsContext.Provider

/** The chatter panel's data path — null when the host mounted no provider. */
export const useChatterOps = chatterOpsContext.useOps
