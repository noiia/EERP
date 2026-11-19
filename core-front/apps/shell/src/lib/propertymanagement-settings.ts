'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for the Property management app's workspace settings (Go:
// GET|PUT /api/v1/settings/propertymanagement, modules/propertymanagement/settings.go).

export interface PropertyManagementSettings {
  /** Print the Tax column on rent receipt PDFs (off by default). */
  display_taxes_on_report: boolean
}

export type SaveResult = { ok: true } | { ok: false; message: string }

export async function getPropertyManagementSettings(): Promise<PropertyManagementSettings | null> {
  try {
    return await apiRequest<PropertyManagementSettings>('GET', '/settings/propertymanagement')
  } catch {
    return null
  }
}

export async function savePropertyManagementSettings(s: PropertyManagementSettings): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/propertymanagement', s)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}
