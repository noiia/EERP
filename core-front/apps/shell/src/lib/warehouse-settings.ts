'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for the warehouse app's workspace settings (Go: GET|PUT
// /api/v1/settings/warehouse, modules/warehouse/reference.go).

export interface WarehouseSettings {
  /** Product references come from the sequence (PRD-00001), read-only. Default true. */
  auto_reference: boolean
}

export type SaveResult = { ok: true } | { ok: false; message: string }

export async function getWarehouseSettings(): Promise<WarehouseSettings | null> {
  try {
    return await apiRequest<WarehouseSettings>('GET', '/settings/warehouse')
  } catch {
    return null
  }
}

export async function saveWarehouseSettings(s: WarehouseSettings): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/warehouse', s)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}
