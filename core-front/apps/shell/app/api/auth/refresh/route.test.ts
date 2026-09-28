import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const bff = vi.hoisted(() => ({
  readRefreshToken: vi.fn(),
  goAuthExchange: vi.fn(),
  setSessionCookies: vi.fn(),
  clearSessionCookies: vi.fn(),
  goLogout: vi.fn(),
}))
vi.mock('@/lib/bff', () => bff)
vi.mock('@/lib/jwt', () => ({ identityFromAccessToken: (t: string) => ({ from: t }) }))

import { POST as refresh } from './route'
import { POST as logout } from '../logout/route'

beforeEach(() => {
  Object.values(bff).forEach((m) => m.mockReset())
})

describe('POST /api/auth/refresh', () => {
  it('answers 401 without a session', async () => {
    bff.readRefreshToken.mockResolvedValue(undefined)
    expect((await refresh()).status).toBe(401)
    expect(bff.goAuthExchange).not.toHaveBeenCalled()
  })

  it('rotates the tokens into cookies and returns the identity', async () => {
    bff.readRefreshToken.mockResolvedValue('R')
    bff.goAuthExchange.mockResolvedValue({ accessToken: 'A', refreshToken: 'R2' })
    const res = await refresh()
    expect(bff.goAuthExchange).toHaveBeenCalledWith('refresh', { refresh_token: 'R' })
    expect(bff.setSessionCookies).toHaveBeenCalledWith({ accessToken: 'A', refreshToken: 'R2' })
    await expect(res.json()).resolves.toEqual({ identity: { from: 'A' } })
  })

  it('clears the session and passes a Go rejection through', async () => {
    bff.readRefreshToken.mockResolvedValue('R')
    bff.goAuthExchange.mockRejectedValue(
      new ApiError({ code: 'UNAUTHENTICATED', message: 'revoked', status: 401 }),
    )
    const res = await refresh()
    expect(res.status).toBe(401)
    expect(bff.clearSessionCookies).toHaveBeenCalled()
  })

  it('clears the session and rethrows unexpected failures', async () => {
    bff.readRefreshToken.mockResolvedValue('R')
    const boom = new TypeError('fetch failed')
    bff.goAuthExchange.mockRejectedValue(boom)
    await expect(refresh()).rejects.toBe(boom)
    expect(bff.clearSessionCookies).toHaveBeenCalled()
  })
})

describe('POST /api/auth/logout', () => {
  it('revokes the refresh token when there is one, and always clears cookies', async () => {
    bff.readRefreshToken.mockResolvedValueOnce('R')
    expect((await logout()).status).toBe(204)
    expect(bff.goLogout).toHaveBeenCalledWith('R')

    bff.readRefreshToken.mockResolvedValueOnce(undefined)
    await logout()
    expect(bff.goLogout).toHaveBeenCalledTimes(1)
    expect(bff.clearSessionCookies).toHaveBeenCalledTimes(2)
  })
})
