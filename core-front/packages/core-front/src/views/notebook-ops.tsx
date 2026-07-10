'use client'
import { createContext, useContext, type ReactNode } from 'react'

// How the notebook renderer reaches RUNTIME, per-record notebook pages
// (docs/roadmaps/responsive-displays.md, Phase 5) — the third category
// ADR-007 names alongside descriptor structure (declared `page` nodes) and
// workspace `app_settings`. Same shape as GraphOps/RelationOps: the functions
// are bound Server Action references the host provides once (root layout) —
// client code never talks to Go directly, and Go authorizes every call from
// the session (permission derives from the /notebook_pages route). Kept as
// its own context, not folded into GraphOps, because it reaches per-RECORD
// data, not per-entity settings.

export interface NotebookPageRecord {
  id: string
  title: string
  content: string
  position: number
}

export interface NotebookOps {
  list: (table: string, recordId: string) => Promise<NotebookPageRecord[]>
  create: (table: string, recordId: string, title: string) => Promise<NotebookPageRecord>
  update: (id: string, patch: { title: string; content: string }) => Promise<NotebookPageRecord>
  remove: (id: string) => Promise<void>
}

const NotebookOpsContext = createContext<NotebookOps | null>(null)

/** Host wiring: mount once (root layout) with bound Server Action references. */
export function NotebookOpsProvider({ ops, children }: { ops: NotebookOps; children: ReactNode }) {
  return <NotebookOpsContext.Provider value={ops}>{children}</NotebookOpsContext.Provider>
}

/**
 * The notebook renderer's data path. Null when the host mounted no provider —
 * the notebook then renders its DECLARED pages only, inert-not-crashing, the
 * same posture RelationOps/GraphOps take for a host with no wiring.
 */
export function useNotebookOps(): NotebookOps | null {
  return useContext(NotebookOpsContext)
}
