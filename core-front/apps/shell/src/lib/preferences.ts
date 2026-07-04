'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'
import type { LocalePreferences } from './locale'

// Server Actions for the language preferences. The browser never calls Go directly:
// these run server-side and hit the dedicated (non-CRUD) backend endpoints through
// the BFF request helper — GET/PUT /me/preferences is self-service (JWT-scoped to
// the caller), PUT /settings/i18n is the tenant default (permission-gated by Go,
// settings:i18n:write). Mutations return a result object instead of throwing:
// Next masks errors thrown inside Server Actions in production, so the envelope
// message would never reach the settings UI otherwise.

export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown, fallback: string): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : fallback }
}

/**
 * Read the caller's language preferences (own choice + workspace default) in one
 * round-trip. Returns null when they cannot be read (expired session, backend
 * down): the UI then keeps the client-persisted locale instead of flashing back
 * to the source language.
 */
export async function getMyLocalePreferences(): Promise<LocalePreferences | null> {
  try {
    return await apiRequest<LocalePreferences>('GET', '/me/preferences')
  } catch {
    return null
  }
}

/**
 * Save the caller's display language: a locale tag, "source" to force the source
 * language, or null to inherit the workspace default.
 */
export async function setMyPreferredLocale(locale: string | null): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/me/preferences', { preferred_locale: locale })
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not save your language preference.')
  }
}

/**
 * Save the workspace default language (null = source language). Go authorizes:
 * callers without settings:i18n:write get the error envelope back as a message.
 */
export async function setDefaultLocale(locale: string | null): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/i18n', { default_locale: locale })
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not save the workspace default language.')
  }
}
