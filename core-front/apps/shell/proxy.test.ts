import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { proxy } from './proxy'

// The generated module manifest is a codegen artefact: keep the registry empty so
// erpRoots is just the shell's own sections (settings, appstore, …).
vi.mock('@/generated/generated-modules', () => ({}))

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

function request(cookieHeader: string, url = 'http://localhost/app/crm'): NextRequest {
  return new NextRequest(url, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  })
}

beforeEach(() => {
  process.env.API_BASE = 'http://api.test'
  delete process.env.API_VERSION
})
afterEach(() => vi.restoreAllMocks())

describe('proxy (legacy ERP paths)', () => {
  it('308-redirects a bare ERP path under /app, keeping the query and the CSP', async () => {
    const res = await proxy(request('', 'http://localhost/settings/users?tab=roles'))
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe('http://localhost/app/settings/users?tab=roles')
    expect(res.headers.get('Content-Security-Policy')).toMatch(/nonce-/)
  })

  it('passes /app, /print and non-ERP paths through', async () => {
    for (const url of ['http://localhost/app/settings', 'http://localhost/print/report/x/1', 'http://localhost/']) {
      const res = await proxy(request('', url))
      expect(res.headers.get('location')).toBeNull()
    }
  })
})

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

  it('sets a fresh, matching CSP nonce on every response (App Router needs it to nonce its own inline hydration scripts)', async () => {
    const res1 = await proxy(request(''))
    const res2 = await proxy(request(''))

    const csp1 = res1.headers.get('Content-Security-Policy')
    const csp2 = res2.headers.get('Content-Security-Policy')
    expect(csp1).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/)
    expect(csp1).not.toBe(csp2) // a fresh nonce per request, never reused
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
