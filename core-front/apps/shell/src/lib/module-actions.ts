'use server'
import { createServerApiClient } from '@eerp/core-front/server'

// Backs the App Store's Activate/Deactivate button (docs/roadmaps/
// app-store.md, Phases 3-4) — the ONE write path that form ever takes,
// entirely separate from the generic form commit (every field on
// /appstore/:id is readOnly, so that path never fires here). Reuses the
// generic entity ApiClient since Go's /api/v1/modules API mimics the
// generic update() shape on purpose (decision #4): PUT /api/v1/modules/:id
// { active }. That same ApiClient.update() already calls
// revalidateTag('modules') internally on success — nothing extra needed here
// for that half of the contract.

export interface SetModuleActiveResult {
  active: boolean
  /** Always true on a successful write (docs/roadmaps/app-store.md, decision
   * #5) — the change is on disk immediately, live only after the next
   * backend restart + frontend rebuild. The button surfaces this as a
   * persistent notice rather than assuming it. */
  requiresRestart: boolean
}

export async function setModuleActive(name: string, active: boolean): Promise<SetModuleActiveResult> {
  const updated = await createServerApiClient().update<{
    active: boolean
    requires_restart?: boolean
  }>('modules', name, { active })
  return { active: updated.active, requiresRestart: updated.requires_restart === true }
}
