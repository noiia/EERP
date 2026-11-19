// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const { goAuthExchange, setSessionCookies } = vi.hoisted(() => ({
  goAuthExchange: vi.fn(),
  setSessionCookies: vi.fn(),
}))
vi.mock('@/lib/bff', () => ({ goAuthExchange, setSessionCookies }))

import { POST } from './route'

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sig`
}
const req = (body: unknown) =>
  new Request('http://localhost/api/auth/ldap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => vi.clearAllMocks())

describe('POST /api/auth/ldap', () => {
  it('relays credentials to ldap/login, sets cookies and returns the identity', async () => {
    const jwt = makeJwt({
      sub: 'u1',
      tenant: 't1',
      roles: ['admin'],
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const tokens = { accessToken: jwt }
    goAuthExchange.mockResolvedValue(tokens)
    const res = await POST(req({ username: 'jdoe', password: 'pw' }))
    expect(goAuthExchange).toHaveBeenCalledWith('ldap/login', { username: 'jdoe', password: 'pw' })
    expect(setSessionCookies).toHaveBeenCalledWith(tokens)
    expect(res.status).toBe(200)
    expect((await res.json()).identity).toMatchObject({ userId: 'u1', tenantId: 't1' })
  })

  it('relays a 401 with Go message and sets no cookies', async () => {
    goAuthExchange.mockRejectedValue(
      new ApiError({
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'Invalid username or password.',
      }),
    )
    const res = await POST(req({ username: 'jdoe', password: 'bad' }))
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toBe('Invalid username or password.')
    expect(setSessionCookies).not.toHaveBeenCalled()
  })

  it('does not throw on a JSON null body', async () => {
    goAuthExchange.mockRejectedValue(
      new ApiError({
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'Invalid username or password.',
      }),
    )
    const res = await POST(
      new Request('http://localhost/api/auth/ldap', { method: 'POST', body: 'null' }),
    )
    expect(goAuthExchange).toHaveBeenCalledWith('ldap/login', {
      username: undefined,
      password: undefined,
    })
    expect(res.status).toBe(401)
  })
})
