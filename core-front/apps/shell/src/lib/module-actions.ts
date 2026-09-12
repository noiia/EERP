'use server'
import { revalidateTag } from 'next/cache'
import { apiRequest, createServerApiClient } from '@eerp/core-front/server'

// Backs the App Store's Activate/Deactivate/Reload buttons and Logs wizard
// (docs/roadmaps/app-store.md) — write paths entirely separate from the
// generic form commit (every field on /appstore/:id is readOnly, so that
// path never fires here).

export interface SetModuleActiveResult {
  active: boolean
}

// Reuses the generic entity ApiClient since Go's /api/v1/modules API mimics
// the generic update() shape on purpose: PUT /api/v1/modules/:id { active }.
// That call now flips the backend's runtime active-gate live (no restart) and
// only then writes module.json — ApiClient.update() already calls
// revalidateTag('modules') on success, which is also what the landing menu
// and catch-all route's live-gating reads (module-state.ts) pick up.
export async function setModuleActive(name: string, active: boolean): Promise<SetModuleActiveResult> {
  const updated = await createServerApiClient().update<{ active: boolean }>('modules', name, { active })
  return { active: updated.active }
}

export interface ReloadModuleResult {
  active: boolean
}

// POST /api/v1/modules/:id/reload — re-instantiates a WASM module's
// (possibly replaced) binary and re-runs its migration with no restart; a
// no-op re-validation for Go-type modules (their code needs a backend
// rebuild+restart to change, a Go-language constraint no endpoint can route
// around — the Reload button hides itself for those, see ActivateButton.tsx).
// Not a generic-entity route, so this goes through apiRequest rather than
// ApiClient.update() — and since apiRequest never auto-revalidates, this
// manually mirrors the same revalidateTag('modules') call update() makes.
export async function reloadModule(name: string): Promise<ReloadModuleResult> {
  const updated = await apiRequest<{ active: boolean }>('POST', `/modules/${name}/reload`)
  // 'max' matches the cache-life profile ApiClient.update()/create()/remove()
  // use internally for this same call shape (Next 16 requires one alongside
  // the tag) — apiRequest bypasses that helper, so this mirrors it by hand.
  revalidateTag('modules', 'max')
  return { active: updated.active }
}

export interface ModuleLogEntry {
  operationId: string
  operation: string
  source: string
  level: string
  message: string
  createdAt: string
}

// GET /api/v1/modules/:id/logs — backs the Logs wizard. Never cached (a
// module's own PUT/reload always changes this, and the wizard wants the
// current state on every open, not a stale Data Cache entry).
export async function getModuleLogs(name: string): Promise<ModuleLogEntry[]> {
  const { data } = await apiRequest<{
    data: {
      operation_id: string
      operation: string
      source: string
      level: string
      message: string
      created_at: string
    }[]
  }>('GET', `/modules/${name}/logs`)
  return data.map((e) => ({
    operationId: e.operation_id,
    operation: e.operation,
    source: e.source,
    level: e.level,
    message: e.message,
    createdAt: e.created_at,
  }))
}
