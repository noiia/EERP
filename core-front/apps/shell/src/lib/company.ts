'use server'
import { ApiError, apiRequest, createServerApiClient } from '@eerp/core-front/server'
import type { LocalePreferences } from './locale'

// Server Actions for multi-company. The browser never calls Go directly.

export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown, fallback: string): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : fallback }
}

export interface CompanyRecord {
  id: string
  name: string
  address?: string
  phone?: string
  email?: string
}

/**
 * List every company in the caller's tenant — the top-bar switcher's menu
 * contents. Degrades to an empty list on any failure (missing
 * company:company:read, session hiccup) rather than throwing: the switcher
 * then just shows the active company with nothing to switch to, same
 * "additive, never breaks the page" posture as getReportsLayout.
 */
export async function listCompanies(): Promise<CompanyRecord[]> {
  try {
    return await createServerApiClient().list<CompanyRecord>('company')
  } catch {
    return []
  }
}

/** Switch the caller's active company. Go authorizes: a company id outside
 * the caller's own tenant is rejected (VALIDATION_ERROR), surfaced as a
 * message rather than thrown. */
export async function setActiveCompany(companyId: string): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/me/preferences', { active_company_id: companyId })
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not switch company.')
  }
}

/**
 * Create a company AND make it the caller's active one, cloning the settings
 * of whichever company the caller was active in at the moment of creation —
 * a one-time deep copy (the plan's "takes the settings and values from the
 * company on which the user created the new one"), not an ongoing
 * inheritance. Matches EntityActions<T>.create's signature exactly, so it
 * slots into the same `actions` object the generic createRecord fills for
 * every other entity's create button — no store/renderer changes needed.
 *
 * Order matters: the source company must be read BEFORE switching, and the
 * clone must happen BEFORE the switch, so `getReportsLayout`-style reads
 * made from the new company's context see the cloned values, not the
 * (not-yet-existing) defaults.
 */
export async function createCompanyAndActivate(body: Partial<CompanyRecord>): Promise<CompanyRecord> {
  const prefs = await apiRequest<LocalePreferences>('GET', '/me/preferences')
  const sourceCompanyId = prefs.active_company?.id

  const created = await createServerApiClient().create<CompanyRecord>('company', body)

  // No source (shouldn't happen post-bootstrap, but the read could fail
  // upstream) just skips cloning rather than failing the whole creation —
  // the new company starts with the built-in defaults instead.
  if (sourceCompanyId) {
    await apiRequest('POST', `/company/${sourceCompanyId}/clone-settings`, {
      target_company_id: created.id,
    })
  }

  await apiRequest('PUT', '/me/preferences', { active_company_id: created.id })

  return created
}
