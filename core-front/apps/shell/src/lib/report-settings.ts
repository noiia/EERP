'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings -> Global settings -> Reports: the workspace-wide
// PDF report letterhead (footer/address). Same shape as app-settings.ts:
// GET/PUT /settings/reports/layout is a dedicated (non-CRUD) backend endpoint
// reached through the BFF request helper, gated by settings:reports:read|write.
// Mutations return a result object instead of throwing — Next masks errors
// thrown inside Server Actions in production.
//
// Looking up a report_page_format row by name is NOT here — that's the print
// route's job (apps/shell/app/print/report/[name]/[id]/page.tsx), which reads
// through a short-lived, TOKEN-scoped createServerApiClient (no session
// cookie), not this file's cookie-bound apiRequest. It calls
// createServerApiClient(token).list('report_page_format', { filter: { name } })
// directly — the generic entity client already unwraps Go's {data,total}
// envelope, so no extra helper is needed here.

export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown, fallback: string): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : fallback }
}

export interface ReportsLayout {
  footer: string
  address: string
}

/** Read the workspace-wide letterhead — empty strings when unconfigured. */
export async function getReportsLayout(): Promise<ReportsLayout> {
  try {
    return await apiRequest<ReportsLayout>('GET', '/settings/reports/layout')
  } catch {
    return { footer: '', address: '' }
  }
}

/** Save the workspace-wide letterhead. Go authorizes: callers without
 * settings:reports:write get the error envelope back as a message. */
export async function setReportsLayout(layout: ReportsLayout): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/reports/layout', layout)
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not save the reports letterhead.')
  }
}
