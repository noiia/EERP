import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { proxy, resetRoutingCache } from './proxy'

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

function goError(status: number): Response {
  return new Response(JSON.stringify({ error: { code: 'X', message: 'x' } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function request(cookieHeader: string, url = 'http://localhost/app/crm'): NextRequest {
  return new NextRequest(url, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  })
}

// Go stand-in: the public routing + published slugs the proxy reads, and a fallback
// for everything else (the auth refresh endpoints).
function go(opts: { routing?: object; slugs?: string[]; other?: (url: string) => Response } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/v1/public/site')) {
      return Response.json({ routing: opts.routing ?? { mode: 'path' } })
    }
    if (url.endsWith('/api/v1/public/website_page?distinct=slug')) {
      return Response.json({ values: (opts.slugs ?? []).map((value) => ({ value, total: 1 })) })
    }
    if (opts.other) return opts.other(url)
    throw new Error(`unexpected fetch ${url}`)
  })
}
const authCalls = (f: ReturnType<typeof go>) => f.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/auth/'))

const hostRouting = { mode: 'host', site_host: 'www.acme.fr', erp_host: 'erp.acme.fr' }

beforeEach(() => {
  process.env.API_BASE = 'http://api.test'
  delete process.env.API_VERSION
  delete process.env.EERP_SITE_ROUTING
  resetRoutingCache()
  vi.stubGlobal('fetch', go())
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('proxy (legacy ERP paths)', () => {
  it('307-redirects a bare ERP path under /app (never 308: the slug set changes), keeping the query and the CSP', async () => {
    const res = await proxy(request('', 'http://localhost/settings/users?tab=roles'))
    expect(res.status).toBe(307)
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

describe('proxy (site routing from Go)', () => {
  it('host mode: an ERP path on the site host 307s to the ERP host', async () => {
    vi.stubGlobal('fetch', go({ routing: hostRouting }))
    const res = await proxy(request('', 'http://www.acme.fr/app/crm?x=1'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://erp.acme.fr/app/crm?x=1')
  })

  it('EERP_SITE_ROUTING=path overrides host mode (admin escape hatch)', async () => {
    process.env.EERP_SITE_ROUTING = 'path'
    vi.stubGlobal('fetch', go({ routing: hostRouting }))
    const res = await proxy(request('', 'http://www.acme.fr/app/crm'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('reads the host from the Host header (set by the gateway), ignoring x-forwarded-host', async () => {
    vi.stubGlobal('fetch', go({ routing: hostRouting }))
    const res = await proxy(new NextRequest('http://core-front:3000/products', { headers: { host: 'erp.acme.fr' } }))
    expect(res.headers.get('location')).toBe('https://www.acme.fr/products')

    const spoofed = await proxy(new NextRequest('http://www.acme.fr/products', {
      headers: { host: 'www.acme.fr', 'x-forwarded-host': 'erp.acme.fr' },
    }))
    expect(spoofed.headers.get('location')).toBeNull()
  })

  it('concurrent cold requests share one routing fetch', async () => {
    const f = go({ routing: hostRouting })
    vi.stubGlobal('fetch', f)
    await Promise.all([proxy(request('', 'http://www.acme.fr/')), proxy(request('', 'http://www.acme.fr/'))])
    expect(f).toHaveBeenCalledTimes(2) // routing + slugs, once for both requests
  })

  it('a hung Go times out (2 s) into path mode', async () => {
    // Never answers; only the fetch's abort signal ends it.
    vi.stubGlobal('fetch', vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })))
    const started = Date.now()
    const res = await proxy(request('', 'http://www.acme.fr/settings/users'))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(res.headers.get('location')).toBe('http://www.acme.fr/app/settings/users')
  })

  it('caches the routing and slugs for 60 s', async () => {
    const f = go({ routing: hostRouting })
    vi.stubGlobal('fetch', f)
    await proxy(request('', 'http://www.acme.fr/'))
    await proxy(request('', 'http://www.acme.fr/'))
    expect(f).toHaveBeenCalledTimes(2) // routing + slugs, once
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    await proxy(request('', 'http://www.acme.fr/'))
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('falls back to path mode when Go is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const res = await proxy(request('', 'http://www.acme.fr/settings/users'))
    expect(res.headers.get('location')).toBe('http://www.acme.fr/app/settings/users')
  })

  it('a published slug equal to an ERP root is served by the site, not redirected', async () => {
    vi.stubGlobal('fetch', go({ slugs: ['settings'] }))
    const res = await proxy(request('', 'http://localhost/settings'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('reads the slugs with ?distinct=slug (no layouts), ignoring the home page\'s empty slug', async () => {
    const f = go({ slugs: ['', 'settings'] })
    vi.stubGlobal('fetch', f)
    const res = await proxy(request('', 'http://localhost/settings'))
    expect(res.headers.get('location')).toBeNull()
    expect(f.mock.calls.map((c) => String(c[0]))).toContain('http://api.test/api/v1/public/website_page?distinct=slug')
  })

  it('forwards the client IP on the public routing reads (per-IP rate limiting)', async () => {
    const f = go({ routing: hostRouting })
    vi.stubGlobal('fetch', f)
    await proxy(new NextRequest('http://www.acme.fr/', { headers: { 'x-forwarded-for': '203.0.113.7' } }))
    const publicCalls = f.mock.calls.filter((c) => String(c[0]).includes('/public/')) as unknown as [string, RequestInit][]
    expect(publicCalls).toHaveLength(2)
    for (const [, init] of publicCalls) {
      expect((init.headers as Record<string, string>)['X-Forwarded-For']).toBe('203.0.113.7')
    }
  })

  it('keeps the last good routing and slugs when a refresh fails (429), retrying after the TTL', async () => {
    vi.stubGlobal('fetch', go({ routing: hostRouting, slugs: ['settings'] }))
    await proxy(request('', 'http://www.acme.fr/'))
    const now = Date.now()
    const limited = vi.fn(async () => goError(429))
    vi.stubGlobal('fetch', limited)
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    // Still host mode: an ERP path on the site host goes to the ERP host.
    const res = await proxy(request('', 'http://www.acme.fr/app/crm'))
    expect(res.headers.get('location')).toBe('https://erp.acme.fr/app/crm')
    // Still knows the slugs: /settings stays a site page.
    expect((await proxy(request('', 'http://www.acme.fr/settings'))).headers.get('location')).toBeNull()
    expect(limited).toHaveBeenCalledTimes(2) // one refresh attempt within the TTL
    vi.spyOn(Date, 'now').mockReturnValue(now + 122_000)
    await proxy(request('', 'http://www.acme.fr/'))
    expect(limited).toHaveBeenCalledTimes(4) // retried after the TTL
  })
})

describe('proxy (session refresh ahead of RSC render)', () => {
  it('passes an anonymous request through untouched (no refresh token to rotate)', async () => {
    const fetchMock = go()
    vi.stubGlobal('fetch', fetchMock)

    const res = await proxy(request(''))
    expect(authCalls(fetchMock)).toEqual([])
    expect(res.cookies.get('eerp_access')).toBeUndefined()
  })

  it('leaves an already-fresh access cookie alone — no refresh attempted', async () => {
    const fetchMock = go()
    vi.stubGlobal('fetch', fetchMock)

    const res = await proxy(request('eerp_access=still-good; eerp_refresh=r1'))
    expect(authCalls(fetchMock)).toEqual([])
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
    vi.stubGlobal('fetch', go({ other: () => refreshResponse('new-access', 'new-refresh') }))

    const res = await proxy(request('eerp_refresh=r1'))
    expect(res.cookies.get('eerp_access')?.value).toBe('new-access')
    expect(res.cookies.get('eerp_refresh')?.value).toBe('new-refresh')
  })

  it('forwards the client IP to Go on a proxy-side refresh (per-IP rate limiting)', async () => {
    const f = go({ other: () => refreshResponse('a', 'r') })
    vi.stubGlobal('fetch', f)
    await proxy(new NextRequest('http://localhost/app/crm', { headers: { cookie: 'eerp_refresh=r1', 'x-forwarded-for': '203.0.113.9' } }))
    const call = f.mock.calls.find((c) => String(c[0]).includes('/auth/refresh')) as unknown as [string, RequestInit]
    expect((call[1].headers as Record<string, string>)['X-Forwarded-For']).toBe('203.0.113.9')
  })

  it('keeps the ERP session on a 429 (not a dead session)', async () => {
    vi.stubGlobal('fetch', go({ other: () => goError(429) }))
    const res = await proxy(request('eerp_refresh=r1'))
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('clears the session when the refresh token is spent/invalid (theft detection)', async () => {
    vi.stubGlobal('fetch', go({ other: () => goError(401) }))

    const res = await proxy(request('eerp_refresh=spent'))
    // A deleted NextResponse cookie serializes as an already-expired Set-Cookie
    // rather than disappearing.
    const setCookies = res.headers.getSetCookie()
    expect(setCookies.some((c) => c.startsWith('eerp_access=') && c.includes('1970'))).toBe(true)
    expect(setCookies.some((c) => c.startsWith('eerp_refresh=') && c.includes('1970'))).toBe(true)
  })
})

describe('proxy (website visitor session refresh)', () => {
  it('rotates the site session at website/auth when only its refresh cookie remains', async () => {
    const f = go({ other: () => refreshResponse('site-access', 'site-refresh') })
    vi.stubGlobal('fetch', f)

    const res = await proxy(request('eerp_site_refresh=s1', 'http://localhost/account'))
    expect(authCalls(f)).toEqual(['http://api.test/api/v1/website/auth/refresh'])
    expect(res.cookies.get('eerp_site_access')?.value).toBe('site-access')
    expect(res.cookies.get('eerp_site_refresh')?.value).toBe('site-refresh')
    expect(res.cookies.get('eerp_access')).toBeUndefined() // the ERP session is untouched
  })

  it('clears the site session on a Go 401', async () => {
    vi.stubGlobal('fetch', go({ other: () => goError(401) }))
    const res = await proxy(request('eerp_site_refresh=spent', 'http://localhost/account'))
    expect(res.headers.getSetCookie().some((c) => c.startsWith('eerp_site_refresh=') && c.includes('1970'))).toBe(true)
  })

  it('keeps the site session on a 429/5xx (not a dead session)', async () => {
    vi.stubGlobal('fetch', go({ other: () => goError(503) }))
    const res = await proxy(request('eerp_site_refresh=s1', 'http://localhost/account'))
    expect(res.headers.getSetCookie()).toEqual([])
  })
})
