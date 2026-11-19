// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'eerp_access' ? { name, value: 'TOKEN' } : undefined),
    set: () => {},
    delete: () => {},
  }),
}))

import { GET } from './route'

beforeEach(() => {
  process.env.API_BASE = 'http://api.test'
  delete process.env.API_VERSION
})
afterEach(() => vi.restoreAllMocks())

const ID = '11111111-2222-3333-4444-555555555555'
const ctx = { params: Promise.resolve({ user: ID }) }

describe('GET /api/avatars/:user', () => {
  it('streams the photo and passes Cache-Control through', async () => {
    const goFetch = vi.fn(
      async () =>
        new Response('img', { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=300' } }),
    )
    vi.stubGlobal('fetch', goFetch)
    const res = await GET(new Request(`http://localhost/api/avatars/${ID}`), ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300')
    await expect(res.text()).resolves.toBe('img')
    expect((goFetch.mock.calls[0] as unknown as [string])[0]).toBe(`http://api.test/api/v1/avatars/${ID}`)
  })

  it('forwards a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'none' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const res = await GET(new Request(`http://localhost/api/avatars/${ID}`), ctx)
    expect(res.status).toBe(404)
  })

  it('404s a non-UUID user without calling Go', async () => {
    const goFetch = vi.fn()
    vi.stubGlobal('fetch', goFetch)
    const res = await GET(new Request('http://localhost/api/avatars/x'), { params: Promise.resolve({ user: '..' }) })
    expect(res.status).toBe(404)
    expect(goFetch).not.toHaveBeenCalled()
  })
})
