import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return { ...actual, apiRequest: (...a: unknown[]) => apiRequestMock(...a) }
})
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'erp.acme.fr' }),
}))

import { ApiError } from '@eerp/core-front/server'
import {
  getPublished,
  getRouting,
  listWebsiteUsers,
  savePublished,
  saveRouting,
  updateWebsiteUser,
} from './website-settings'

beforeEach(() => {
  apiRequestMock.mockReset()
})

describe('website-settings actions', () => {
  it('saveRouting PUTs with the browser Host in X-EERP-Request-Host', async () => {
    apiRequestMock.mockResolvedValue(undefined)
    const r = { mode: 'host' as const, site_host: 'www.acme.fr', erp_host: 'erp.acme.fr' }
    await expect(saveRouting(r)).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/settings/website/routing', r, {
      'X-EERP-Request-Host': 'erp.acme.fr',
    })
  })

  it('returns Go\'s message on a rejected save', async () => {
    apiRequestMock.mockImplementation(() =>
      Promise.reject(new ApiError({ code: 'BAD', message: 'nope', status: 400 })),
    )
    await expect(saveRouting({ mode: 'path', site_host: '', erp_host: '' })).resolves.toEqual({
      ok: false,
      message: 'nope',
    })
  })

  it('reads and writes published data and users', async () => {
    apiRequestMock.mockResolvedValue([])
    await getPublished()
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/settings/website/public')
    await getRouting()
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/settings/website/routing')
    await listWebsiteUsers()
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/website_admin/users')
    await savePublished('product', { fields: ['name'], filter: { active: 'true' } })
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/settings/website/public/product', {
      fields: ['name'],
      filter: { active: 'true' },
    })
    await updateWebsiteUser('u1', { disabled: true })
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/website_admin/users/u1', { disabled: true })
  })
})
