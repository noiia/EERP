import { beforeEach, describe, expect, it, vi } from 'vitest'

// The cookie read/clear helpers of both sessions (ERP and website) — kept apart
// so a website token never rides an ERP call.
const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined),
    delete: (n: string) => jar.delete(n),
    set: (n: string, v: string) => jar.set(n, v),
  }),
  headers: async () => new Headers(),
}))

import { ACCESS_COOKIE, REFRESH_COOKIE } from '@eerp/core-front/server'
import { clearSessionCookies, readRefreshToken } from './bff'
import { SITE_ACCESS_COOKIE, SITE_REFRESH_COOKIE, clearSiteSessionCookies, readSiteRefreshToken } from './site-session'
import { getEffectivePermissions } from './session'

beforeEach(() => jar.clear())

describe('ERP session cookies', () => {
  it('reads the refresh token and clears both cookies', async () => {
    expect(await readRefreshToken()).toBeUndefined()
    jar.set(ACCESS_COOKIE, 'a').set(REFRESH_COOKIE, 'r').set(SITE_REFRESH_COOKIE, 's')
    expect(await readRefreshToken()).toBe('r')
    await clearSessionCookies()
    expect([...jar.keys()]).toEqual([SITE_REFRESH_COOKIE])
  })

  it('has no permissions without a session', async () => {
    expect(await getEffectivePermissions()).toEqual([])
  })
})

describe('website session cookies', () => {
  it('reads the refresh token and clears both cookies', async () => {
    jar.set(SITE_ACCESS_COOKIE, 'a').set(SITE_REFRESH_COOKIE, 's').set(REFRESH_COOKIE, 'r')
    expect(await readSiteRefreshToken()).toBe('s')
    await clearSiteSessionCookies()
    expect([...jar.keys()]).toEqual([REFRESH_COOKIE])
  })
})
