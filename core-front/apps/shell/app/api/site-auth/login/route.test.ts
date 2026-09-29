import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cookieJar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set: (name: string, value: string) => {
      cookieJar.set(name, value)
    },
    delete: (name: string) => {
      cookieJar.delete(name)
    },
  }),
}))

import { POST } from './route'

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sig`
}

function loginRequest(body: unknown): Request {
  return new Request('http://localhost/api/site-auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function goLoginOk(jwt: string, refresh: string): Response {
  return new Response(JSON.stringify({ access_token: jwt, token_type: 'Bearer', expires_in: 3600 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': `refresh_token=${refresh}; Path=/; HttpOnly` },
  })
}

const future = Math.floor(Date.now() / 1000) + 3600

beforeEach(() => {
  cookieJar.clear()
  process.env.API_BASE = 'http://api.test'
  delete process.env.API_VERSION
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/site-auth/login', () => {
  it('calls Go website auth and stores SITE cookies, never the ERP ones', async () => {
    const jwt = makeJwt({ sub: 'u1', tenant: 't1', aud: ['website'], exp: future })
    const fetchMock = vi.fn(async (..._a: unknown[]) => goLoginOk(jwt, 'r1'))
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(loginRequest({ email: 'v@x.io', password: 'correct horse' }))

    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/v1/website/auth/login')
    expect(cookieJar.get('eerp_site_access')).toBe(jwt)
    expect(cookieJar.get('eerp_site_refresh')).toBe('r1')
    expect(cookieJar.has('eerp_access')).toBe(false)
  })

  it('passes a Go error through with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password.' } }), { status: 401 })))
    const res = await POST(loginRequest({ email: 'v@x.io', password: 'bad' }))
    expect(res.status).toBe(401)
    expect(cookieJar.size).toBe(0)
  })
})
