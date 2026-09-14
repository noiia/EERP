'use client'
import { createOpsContext } from './ops-context'

// How the notebook renderer reaches RUNTIME, per-record notebook pages
// (docs/roadmaps/responsive-displays.md, Phase 5) — the third category ADR-007
// names alongside descriptor structure (declared `page` nodes) and workspace
// `app_settings`. Kept as its own context, not folded into GraphOps, because it
// reaches per-RECORD data, not per-entity settings. See ops-context.tsx for the
// shared wiring contract.

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

const notebookOpsContext = createOpsContext<NotebookOps>()

/** Host wiring: mount once (root layout) with bound Server Action references. */
export const NotebookOpsProvider = notebookOpsContext.Provider

/** The notebook renderer's data path — null when the host mounted no provider. */
export const useNotebookOps = notebookOpsContext.useOps
