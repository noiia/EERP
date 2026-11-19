'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'
import { EMPTY_STATUS_BAR_CONFIG, type StatusBarConfig } from '@eerp/core-front'

// Server Actions for a form's status-breadcrumb override, set per entity from
// Settings -> Apps -> :module. Same shape as chatter-visibility.ts: GET/PUT
// /settings/views/:entity/status_bar, gated by settings:views:read|write.
// Mutations return a result object instead of throwing — Next masks errors
// thrown inside Server Actions in production.

export type SaveResult = { ok: true } | { ok: false; message: string }

/** One entity's override; degrades to "no override" on any failure. */
export async function getEntityStatusBarConfig(entity: string): Promise<StatusBarConfig> {
  try {
    const raw = await apiRequest<{ field: string | null; steps: string[] | null }>(
      'GET',
      `/settings/views/${entity}/status_bar`,
    )
    return { field: raw.field ?? null, steps: raw.steps ?? null }
  } catch {
    return EMPTY_STATUS_BAR_CONFIG
  }
}

/** Save (or, with both parts null, clear) one entity's override. */
export async function setEntityStatusBarConfig(entity: string, config: StatusBarConfig): Promise<SaveResult> {
  try {
    await apiRequest('PUT', `/settings/views/${entity}/status_bar`, config)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : 'Could not save the status bar setting.' }
  }
}
