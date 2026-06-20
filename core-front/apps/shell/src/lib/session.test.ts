import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cookieJar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
  }),
}))

const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirectMock(url) }))

import { getIdentity, requireAuth } from './session'

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sig`
}
const future = Math.floor(Date.now() / 1000) + 3600

beforeEach(() => {
  cookieJar.clear()
  redirectMock.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('getIdentity', () => {
  it('returns null when there is no access cookie', async () => {
    expect(await getIdentity()).toBeNull()
  })

  it('decodes identity from the access cookie', async () => {
    cookieJar.set('eerp_access', makeJwt({ sub: 'u1', tenant: 't1', roles: ['admin'], exp: future }))
    expect((await getIdentity())?.userId).toBe('u1')
  })
})

describe('requireAuth', () => {
  it('redirects anonymous requests to /login carrying the intended path', async () => {
    await expect(requireAuth('/crm/contacts')).rejects.toThrow('NEXT_REDIRECT:/login?next=%2Fcrm%2Fcontacts')
    expect(redirectMock).toHaveBeenCalledWith('/login?next=%2Fcrm%2Fcontacts')
  })

  it('returns the identity when authenticated', async () => {
    cookieJar.set('eerp_access', makeJwt({ sub: 'u9', tenant: 't1', roles: [], exp: future }))
    const identity = await requireAuth('/crm')
    expect(identity.userId).toBe('u9')
    expect(redirectMock).not.toHaveBeenCalled()
  })
})
