import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { getSiteIdentity } from './site-session'

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sig`
}
const future = Math.floor(Date.now() / 1000) + 3600

beforeEach(() => cookieJar.clear())

describe('getSiteIdentity', () => {
  it('reads identity from the site cookie only', async () => {
    cookieJar.set('eerp_access', makeJwt({ sub: 'staff', tenant: 't', exp: future }))
    expect(await getSiteIdentity()).toBeNull()
    cookieJar.set('eerp_site_access', makeJwt({ sub: 'visitor', tenant: 't', aud: ['website'], exp: future }))
    expect((await getSiteIdentity())?.userId).toBe('visitor')
  })
})
