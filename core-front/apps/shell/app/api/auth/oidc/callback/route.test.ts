// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const jar = new Map<string, string>()
const deletes: { name: string; path?: string }[] = []
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
    delete: (arg: string | { name: string; path?: string }) => {
      const o = typeof arg === 'string' ? { name: arg } : arg
      deletes.push(o)
      jar.delete(o.name)
    },
  }),
}))
const { goAuthExchange, setSessionCookies } = vi.hoisted(() => ({
  goAuthExchange: vi.fn(),
  setSessionCookies: vi.fn(),
}))
vi.mock('@/lib/bff', () => ({ goAuthExchange, setSessionCookies }))

import { GET } from './route'

const saved = (over: object = {}) =>
  JSON.stringify({
    provider: 'corp',
    state: 'S',
    nonce: 'N',
    verifier: 'V',
    next: '/contacts',
    ...over,
  })
const call = (qs: string) => GET(new Request(`http://localhost/api/auth/oidc/callback${qs}`))
const isFail = (res: Response) => {
  const loc = new URL(res.headers.get('location')!)
  return loc.pathname === '/app/login' && loc.search === '?error=sso'
}

beforeEach(() => {
  jar.clear()
  deletes.length = 0
  vi.clearAllMocks()
})

describe('GET /api/auth/oidc/callback', () => {
  it.each([
    ['no cookie', undefined, '?code=c&state=S'],
    ['unparseable cookie', '{nope', '?code=c&state=S'],
    ['state mismatch', saved(), '?code=c&state=X'],
    ['provider error', saved(), '?error=access_denied&state=S'],
    ['provider error with code', saved(), '?error=access_denied&code=c&state=S'],
    ['missing code', saved(), '?state=S'],
  ])('logs nobody in: %s', async (_n, cookie, qs) => {
    if (cookie !== undefined) jar.set('eerp_oidc', cookie)
    const res = await call(qs)
    expect(isFail(res)).toBe(true)
    expect(goAuthExchange).not.toHaveBeenCalled()
    expect(setSessionCookies).not.toHaveBeenCalled()
    expect(jar.has('eerp_oidc')).toBe(false)
    expect(deletes).toEqual([{ name: 'eerp_oidc', path: '/api/auth/oidc' }])
  })

  it('exchanges the code, sets cookies, redirects to next and clears the cookie', async () => {
    jar.set('eerp_oidc', saved())
    goAuthExchange.mockResolvedValue({ accessToken: 'a' })
    const res = await call('?code=abc&state=S')
    expect(goAuthExchange).toHaveBeenCalledWith('oidc/providers/corp/exchange', {
      code: 'abc',
      code_verifier: 'V',
      nonce: 'N',
    })
    expect(setSessionCookies).toHaveBeenCalledWith({ accessToken: 'a' })
    expect(new URL(res.headers.get('location')!).pathname).toBe('/app/contacts')
    expect(jar.has('eerp_oidc')).toBe(false)
    expect(deletes).toEqual([{ name: 'eerp_oidc', path: '/api/auth/oidc' }])
  })

  it('redirects to the login error when the exchange fails', async () => {
    jar.set('eerp_oidc', saved())
    goAuthExchange.mockRejectedValue(new Error('401'))
    expect(isFail(await call('?code=abc&state=S'))).toBe(true)
    expect(setSessionCookies).not.toHaveBeenCalled()
    expect(jar.has('eerp_oidc')).toBe(false)
    expect(deletes).toEqual([{ name: 'eerp_oidc', path: '/api/auth/oidc' }])
  })

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example'])(
    'keeps next=%s inside the ERP',
    async (next) => {
      jar.set('eerp_oidc', saved({ next }))
      goAuthExchange.mockResolvedValue({ accessToken: 'a' })
      const loc = new URL((await call('?code=abc&state=S')).headers.get('location')!)
      expect(deletes).toEqual([{ name: 'eerp_oidc', path: '/api/auth/oidc' }])
      expect(loc.origin).toBe('http://localhost')
      expect(loc.pathname.startsWith('/app/')).toBe(true)
    },
  )
})
