import { beforeEach, describe, expect, it, vi } from 'vitest'

const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined) }),
  headers: async () => new Headers(),
}))

import { getMyBookings, getWebsiteMe } from './account'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  jar.clear()
  process.env.API_BASE = 'http://api.test'
  vi.unstubAllGlobals()
})

describe('getWebsiteMe', () => {
  it('is null without a session or when Go rejects it', async () => {
    expect(await getWebsiteMe()).toBeNull()
    jar.set('eerp_site_access', 'tok')
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 401)))
    expect(await getWebsiteMe()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 404)))
    expect(await getWebsiteMe()).toBeNull()
  })

  it('returns the profile and throws on a server error', async () => {
    jar.set('eerp_site_access', 'tok')
    vi.stubGlobal('fetch', vi.fn(async () => json({ email: 'v@x.io' })))
    expect(await getWebsiteMe()).toEqual({ email: 'v@x.io' })
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)))
    await expect(getWebsiteMe()).rejects.toThrow('website/me: 500')
  })
})

describe('getMyBookings', () => {
  it("returns the visitor's bookings, null otherwise", async () => {
    expect(await getMyBookings()).toBeNull()
    jar.set('eerp_site_access', 'tok')
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'b1' }] })))
    expect(await getMyBookings()).toEqual([{ id: 'b1' }])
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)))
    expect(await getMyBookings()).toBeNull()
  })
})
