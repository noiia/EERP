import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { proxy } from './proxy'

// Go's refresh response: new access token in the body, rotated refresh token in a
// Set-Cookie header (never in the body) — same shape ApiClient.test.ts exercises.
function refreshResponse(access: string, rotatedRefresh: string): Response {
  return new Response(JSON.stringify({ access_token: access, token_type: 'Bearer', expires_in: 3600 }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `refresh_token=${rotatedRefresh}; Path=/; HttpOnly`,
    },
  })
}

function request(cookieHeader: string): NextRequest {
  return new NextRequest('http://localhost/crm', {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  })
}

beforeEach(() => {
  process.env.API_BASE = 'http://api.test'
  delete process.env.API_VERSION
})
afterEach(() => vi.restoreAllMocks())

describe('proxy (session refresh ahead of RSC render)', () => {
  it('passes an anonymous request through untouched (no refresh token to rotate)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await proxy(request(''))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.cookies.get('eerp_access')).toBeUndefined()
  })

  it('leaves an already-fresh access cookie alone — no refresh attempted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await proxy(request('eerp_access=still-good; eerp_refresh=r1'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.cookies.get('eerp_access')).toBeUndefined()
  })

  it('rotates the session when the access cookie is gone but a refresh token remains', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refreshResponse('new-access', 'new-refresh')))

    const res = await proxy(request('eerp_refresh=r1'))
    expect(res.cookies.get('eerp_access')?.value).toBe('new-access')
    expect(res.cookies.get('eerp_refresh')?.value).toBe('new-refresh')
  })

  it('clears the session when the refresh token is spent/invalid (theft detection)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'REFRESH_REUSED', message: 'theft' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )

    const res = await proxy(request('eerp_refresh=spent'))
    // A deleted NextResponse cookie serializes as an already-expired Set-Cookie
    // rather than disappearing.
    const setCookies = res.headers.getSetCookie()
    expect(setCookies.some((c) => c.startsWith('eerp_access=') && c.includes('1970'))).toBe(true)
    expect(setCookies.some((c) => c.startsWith('eerp_refresh=') && c.includes('1970'))).toBe(true)
  })
})
