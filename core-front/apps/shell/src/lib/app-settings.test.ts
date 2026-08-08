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

import { getModulePictureSize, setModulePictureSize } from './app-settings'

beforeEach(() => {
  apiRequestMock.mockReset()
})

describe('getModulePictureSize', () => {
  it('reads the module\'s own size from GET /settings/apps/:module/picture-size', async () => {
    apiRequestMock.mockResolvedValue({ size: { width: 200, height: 150 } })

    await expect(getModulePictureSize('crm')).resolves.toEqual({ width: 200, height: 150 })
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/settings/apps/crm/picture-size')
  })

  it('reads null when nothing is configured at that level', async () => {
    apiRequestMock.mockResolvedValue({ size: null })
    await expect(getModulePictureSize('crm')).resolves.toBeNull()
  })

  it('degrades to null instead of throwing when the read fails', async () => {
    apiRequestMock.mockRejectedValue(new ApiError({ code: 'FORBIDDEN', message: 'x', status: 403 }))
    await expect(getModulePictureSize('crm')).resolves.toBeNull()
  })
})

describe('setModulePictureSize', () => {
  it('saves via PUT /settings/apps/:module/picture-size', async () => {
    apiRequestMock.mockResolvedValue(undefined)

    await expect(setModulePictureSize('crm', { width: 300, height: 300 })).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/settings/apps/crm/picture-size', {
      size: { width: 300, height: 300 },
    })
  })

  it('clears the override with size: null', async () => {
    apiRequestMock.mockResolvedValue(undefined)

    await expect(setModulePictureSize('crm', null)).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/settings/apps/crm/picture-size', { size: null })
  })

  it('maps a failed save to { ok:false } carrying the envelope message', async () => {
    apiRequestMock.mockRejectedValue(
      new ApiError({ code: 'FORBIDDEN', message: 'Missing permission settings:apps:write', status: 403 }),
    )

    await expect(setModulePictureSize('crm', { width: 300, height: 300 })).resolves.toEqual({
      ok: false,
      message: 'Missing permission settings:apps:write',
    })
  })

  it('falls back to a generic message on non-ApiError failures', async () => {
    apiRequestMock.mockRejectedValue(new TypeError('fetch failed'))

    await expect(setModulePictureSize('crm', { width: 300, height: 300 })).resolves.toEqual({
      ok: false,
      message: 'Could not save the picture size.',
    })
  })
})
