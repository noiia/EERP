import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  }
})

import {
  getMyLocalePreferences,
  setDefaultLocale,
  setMyPreferredLocale,
  setWorkspaceNumberFormat,
} from './preferences'

beforeEach(() => {
  apiRequestMock.mockReset()
})

describe('locale preference actions', () => {
  it('reads own + workspace preferences from GET /me/preferences', async () => {
    apiRequestMock.mockResolvedValue({ preferred_locale: 'fr', default_locale: null })

    await expect(getMyLocalePreferences()).resolves.toEqual({
      preferred_locale: 'fr',
      default_locale: null,
    })
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/me/preferences')
  })

  it('returns null instead of throwing when the read fails (UI keeps local state)', async () => {
    apiRequestMock.mockRejectedValue(new ApiError({ code: 'UNAUTHENTICATED', message: 'x', status: 401 }))
    await expect(getMyLocalePreferences()).resolves.toBeNull()
  })

  it('saves the personal preference via PUT /me/preferences', async () => {
    apiRequestMock.mockResolvedValue(undefined)

    await expect(setMyPreferredLocale('source')).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/me/preferences', {
      preferred_locale: 'source',
    })
  })

  it('saves the workspace default via PUT /settings/i18n', async () => {
    apiRequestMock.mockResolvedValue(undefined)

    await expect(setDefaultLocale('fr')).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/settings/i18n', { default_locale: 'fr' })
  })

  it('saves the workspace number format via PUT /settings/format', async () => {
    apiRequestMock.mockResolvedValue(undefined)

    await expect(
      setWorkspaceNumberFormat({ decimal_separator: ',', thousands_separator: ' ' }),
    ).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/settings/format', {
      decimal_separator: ',',
      thousands_separator: ' ',
    })
  })

  it('maps a failed save to { ok:false } carrying the envelope message', async () => {
    apiRequestMock.mockRejectedValue(
      new ApiError({ code: 'FORBIDDEN', message: 'Missing permission settings:i18n:write', status: 403 }),
    )

    await expect(setDefaultLocale('fr')).resolves.toEqual({
      ok: false,
      message: 'Missing permission settings:i18n:write',
    })
  })

  it('falls back to a generic message on non-ApiError failures', async () => {
    apiRequestMock.mockRejectedValue(new TypeError('fetch failed'))

    await expect(setMyPreferredLocale(null)).resolves.toEqual({
      ok: false,
      message: 'Could not save your language preference.',
    })
  })
})
