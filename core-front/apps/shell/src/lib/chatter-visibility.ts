'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'
import { EMPTY_CHATTER_VISIBILITY, type ChatterVisibilityConfig } from '@eerp/core-front'

// Server Actions for the form chatter-panel visibility override an admin sets
// per entity from Settings -> Apps -> :module ("Form chatter panel" row).
// Same shape as view-fields.ts: GET/PUT /settings/views/:entity/chatter is a
// dedicated (non-CRUD) backend endpoint reached through the BFF request
// helper, gated by settings:views:read|write. Mutations return a result
// object instead of throwing — Next masks errors thrown inside Server Actions
// in production, so the envelope message would never reach the settings UI
// otherwise.

export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown, fallback: string): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : fallback }
}

/**
 * Read one entity's chatter-visibility override. Degrades to the empty
 * config (no override) on any failure (missing settings:views:read, session
 * hiccup) rather than throwing — the settings UI then just shows it as
 * "inheriting the module default".
 */
export async function getEntityChatterVisibility(entity: string): Promise<ChatterVisibilityConfig> {
  try {
    const raw = await apiRequest<{ enabled: boolean | null }>('GET', `/settings/views/${entity}/chatter`)
    return { enabled: raw.enabled }
  } catch {
    return EMPTY_CHATTER_VISIBILITY
  }
}

/**
 * Save (or, with `enabled: null`, clear) one entity's chatter-visibility
 * override. Go authorizes: callers without settings:views:write get the
 * error envelope back as a message.
 */
export async function setEntityChatterVisibility(
  entity: string,
  enabled: boolean | null,
): Promise<SaveResult> {
  try {
    await apiRequest('PUT', `/settings/views/${entity}/chatter`, { enabled })
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not save the chatter visibility setting.')
  }
}
