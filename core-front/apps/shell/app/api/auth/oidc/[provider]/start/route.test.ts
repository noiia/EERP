// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const set = vi.fn()
vi.mock('next/headers', () => ({ cookies: async () => ({ set }) }))
vi.mock('@/lib/bff', () => ({ forwardedFor: async () => ({}) }))

import { GET } from './route'

const call = (qs = '') =>
  GET(new Request(`http://localhost/api/auth/oidc/corp/start${qs}`), {
    params: Promise.resolve({ provider: 'corp' }),
  })

beforeEach(() => {
  set.mockClear()
  process.env.API_BASE = 'http://api.test'
})
afterEach(() => vi.unstubAllGlobals())

describe('GET /api/auth/oidc/[provider]/start', () => {
  it('sends the PKCE challenge to Go, stores the cookie and redirects to the IdP', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ url: 'https://idp.example/auth?x=1' })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const res = await call('?next=/contacts')
    expect([302, 307]).toContain(res.status)
    expect(res.headers.get('location')).toBe('https://idp.example/auth?x=1')

    const [name, value, opts] = set.mock.calls[0]
    expect(name).toBe('eerp_oidc')
    const saved = JSON.parse(value)
    expect(saved).toMatchObject({ provider: 'corp', next: '/contacts' })
    expect(opts).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/auth/oidc',
      maxAge: 600,
    })

    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0])
    expect(url.pathname).toBe('/api/v1/auth/oidc/providers/corp/authorize')
    expect(url.searchParams.get('state')).toBe(saved.state)
    expect(url.searchParams.get('nonce')).toBe(saved.nonce)
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(saved.verifier).digest('base64url'),
    )
    expect(url.searchParams.has('redirect_uri')).toBe(false)
  })

  it('redirects to the login error and sets no cookie when Go answers 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    )
    const res = await call()
    expect(new URL(res.headers.get('location')!).pathname).toBe('/app/login')
    expect(res.headers.get('location')).toContain('error=sso')
    expect(set).not.toHaveBeenCalled()
  })

  it('stores / when next is longer than 512 characters', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ url: 'https://idp.example/a' }))),
    )
    await call('?next=/' + 'a'.repeat(600))
    expect(JSON.parse(set.mock.calls[0][1]).next).toBe('/')
  })
})
