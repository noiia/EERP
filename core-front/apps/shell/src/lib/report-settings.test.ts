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

import { getReportsLayout, setReportsLayout } from './report-settings'

beforeEach(() => {
  apiRequestMock.mockReset()
})

describe('getReportsLayout', () => {
  it('reads the letterhead from GET /settings/reports/layout', async () => {
    apiRequestMock.mockResolvedValue({ footer: 'Thank you.', address: '1 Rue de la Paix' })

    await expect(getReportsLayout()).resolves.toEqual({ footer: 'Thank you.', address: '1 Rue de la Paix' })
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/settings/reports/layout')
  })

  it('degrades to empty strings instead of throwing when the read fails', async () => {
    apiRequestMock.mockRejectedValue(new ApiError({ code: 'FORBIDDEN', message: 'x', status: 403 }))
    await expect(getReportsLayout()).resolves.toEqual({ footer: '', address: '' })
  })
})

describe('setReportsLayout', () => {
  it('saves via PUT /settings/reports/layout', async () => {
    apiRequestMock.mockResolvedValue(undefined)

    await expect(
      setReportsLayout({ footer: 'Thank you.', address: '1 Rue de la Paix' }),
    ).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/settings/reports/layout', {
      footer: 'Thank you.',
      address: '1 Rue de la Paix',
    })
  })

  it('maps a failed save to { ok:false } carrying the envelope message', async () => {
    apiRequestMock.mockRejectedValue(
      new ApiError({ code: 'FORBIDDEN', message: 'Missing permission settings:reports:write', status: 403 }),
    )

    await expect(setReportsLayout({ footer: '', address: '' })).resolves.toEqual({
      ok: false,
      message: 'Missing permission settings:reports:write',
    })
  })

  it('falls back to a generic message on non-ApiError failures', async () => {
    apiRequestMock.mockRejectedValue(new TypeError('fetch failed'))

    await expect(setReportsLayout({ footer: '', address: '' })).resolves.toEqual({
      ok: false,
      message: 'Could not save the reports letterhead.',
    })
  })
})
