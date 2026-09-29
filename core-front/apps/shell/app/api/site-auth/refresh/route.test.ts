import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const bff = vi.hoisted(() => ({ goAuthExchange: vi.fn() }))
const site = vi.hoisted(() => ({
  readSiteRefreshToken: vi.fn(),
  setSiteSessionCookies: vi.fn(),
  clearSiteSessionCookies: vi.fn(),
}))
vi.mock('@/lib/bff', () => bff)
vi.mock('@/lib/site-session', () => site)
vi.mock('@/lib/jwt', () => ({ identityFromAccessToken: (t: string) => ({ from: t }) }))

import { POST as refresh } from './route'

beforeEach(() => {
  ;[...Object.values(bff), ...Object.values(site)].forEach((m) => m.mockReset())
  site.readSiteRefreshToken.mockResolvedValue('R')
})

const goError = (status: number, code: string) => new ApiError({ code, message: code, status })

describe('POST /api/site-auth/refresh', () => {
  it('rotates the site cookies on success', async () => {
    bff.goAuthExchange.mockResolvedValue({ accessToken: 'A', refreshToken: 'R2' })
    const res = await refresh()
    expect(bff.goAuthExchange).toHaveBeenCalledWith('refresh', { refresh_token: 'R' }, 'website/auth')
    expect(site.setSiteSessionCookies).toHaveBeenCalled()
    await expect(res.json()).resolves.toEqual({ identity: { from: 'A' } })
  })

  it('clears the session only on a 401 from Go', async () => {
    bff.goAuthExchange.mockRejectedValue(goError(401, 'UNAUTHENTICATED'))
    expect((await refresh()).status).toBe(401)
    expect(site.clearSiteSessionCookies).toHaveBeenCalled()
  })

  it.each([
    [429, 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'],
  ])('keeps the session on a %i', async (status, code) => {
    bff.goAuthExchange.mockRejectedValue(goError(status, code))
    expect((await refresh()).status).toBe(status)
    expect(site.clearSiteSessionCookies).not.toHaveBeenCalled()
  })

  it('keeps the session on a network error and answers 502', async () => {
    bff.goAuthExchange.mockRejectedValue(new TypeError('fetch failed'))
    expect((await refresh()).status).toBe(502)
    expect(site.clearSiteSessionCookies).not.toHaveBeenCalled()
  })
})
