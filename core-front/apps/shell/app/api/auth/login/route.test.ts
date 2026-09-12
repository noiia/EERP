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
  return new Request('http://localhost/api/auth/login', {
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

describe('POST /api/auth/login', () => {
  it('sets the session cookies and returns the identity on success', async () => {
    const jwt = makeJwt({ sub: 'u1', tenant: 't1', roles: ['admin'], exp: future })
    vi.stubGlobal('fetch', vi.fn(async () => goLoginOk(jwt, 'GOREFRESH')))

    const res = await POST(loginRequest({ email: 'a@b.c', password: 'pw' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.identity).toMatchObject({ userId: 'u1', tenantId: 't1', roles: ['admin'] })
    // Tokens stored on the Next domain; refresh captured from Go's Set-Cookie header.
    expect(cookieJar.get('eerp_access')).toBe(jwt)
    expect(cookieJar.get('eerp_refresh')).toBe('GOREFRESH')
  })

  it('surfaces the Go ApiError on bad credentials and sets no cookies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password.', request_id: 'r1' },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )

    const res = await POST(loginRequest({ email: 'a@b.c', password: 'bad' }))
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error.message).toBe('Invalid email or password.')
    expect(cookieJar.has('eerp_access')).toBe(false)
  })
})
