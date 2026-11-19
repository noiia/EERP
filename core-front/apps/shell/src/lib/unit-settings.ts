'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings -> Global settings -> Units: the workspace's
// default unit system (metric or imperial) — propertymanagement's own
// Create override reads the SAME setting server-side to pick a sensible
// default floor_area uom (square meter vs. square foot) for a new property.
// Same shape as tax-settings.ts: GET/PUT /settings/units is a dedicated
// (non-CRUD) backend endpoint reached through the BFF request helper, gated
// by settings:units:read|write. Mutations return a result object instead of
// throwing — Next masks errors thrown inside Server Actions in production.

export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown, fallback: string): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : fallback }
}

export type UnitSystem = 'metric' | 'imperial'

export interface UnitSettings {
  system: UnitSystem
}

const DEFAULT_UNIT_SETTINGS: UnitSettings = { system: 'metric' }

/** Read the workspace's default unit system — metric when unconfigured. */
export async function getUnitSettings(): Promise<UnitSettings> {
  try {
    return await apiRequest<UnitSettings>('GET', '/settings/units')
  } catch {
    return DEFAULT_UNIT_SETTINGS
  }
}

/** Save the workspace's default unit system. Go authorizes: callers without
 * settings:units:write get the error envelope back as a message. */
export async function setUnitSettings(settings: UnitSettings): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/units', settings)
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not save the unit system.')
  }
}
