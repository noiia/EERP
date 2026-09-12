'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings -> Global settings -> Tax: the workspace's tax
// pricing mode — whether a line's price already has tax baked in
// (tax_included) or has tax computed on top of it (tax_excluded, the
// original behavior). Same shape as osm-settings.ts: GET/PUT /settings/tax is
// a dedicated (non-CRUD) backend endpoint reached through the BFF request
// helper, gated by settings:tax:read|write. Mutations return a result object
// instead of throwing — Next masks errors thrown inside Server Actions in
// production.

export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown, fallback: string): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : fallback }
}

export type TaxPriceMode = 'tax_excluded' | 'tax_included'

export interface TaxSettings {
  price_mode: TaxPriceMode
}

const DEFAULT_TAX_SETTINGS: TaxSettings = { price_mode: 'tax_excluded' }

/** Read the workspace's tax price mode — tax_excluded when unconfigured. */
export async function getTaxSettings(): Promise<TaxSettings> {
  try {
    return await apiRequest<TaxSettings>('GET', '/settings/tax')
  } catch {
    return DEFAULT_TAX_SETTINGS
  }
}

/** Save the workspace's tax price mode. Go authorizes: callers without
 * settings:tax:write get the error envelope back as a message. */
export async function setTaxSettings(settings: TaxSettings): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/tax', settings)
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not save the tax price mode.')
  }
}
