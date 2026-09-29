import { beforeEach, describe, expect, it, vi } from 'vitest'

const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined) }),
}))

import { saveProfile } from './account-actions'

const form = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}

beforeEach(() => {
  jar.clear()
  process.env.API_BASE = 'http://api.test'
  vi.unstubAllGlobals()
})

describe('saveProfile', () => {
  it('PUTs the profile to /website/me with the site access token', async () => {
    jar.set('eerp_site_access', 'tok')
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    expect(await saveProfile(null, form({ name: 'Ada', surname: 'L', phone: '1' }))).toEqual({ ok: true })
    expect(f).toHaveBeenCalledWith('http://api.test/api/v1/website/me', expect.objectContaining({
      method: 'PUT',
      headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      body: JSON.stringify({ name: 'Ada', surname: 'L', phone: '1' }),
    }))
  })

  it('maps failures to codes the form translates', async () => {
    expect(await saveProfile(null, form({ name: 'Ada' }))).toEqual({ ok: false, error: 'session' })
    jar.set('eerp_site_access', 'tok')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })))
    expect(await saveProfile(null, form({ name: '' }))).toEqual({ ok: false, error: 'invalid' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    expect(await saveProfile(null, form({ name: 'Ada' }))).toEqual({ ok: false, error: 'failed' })
  })
})
