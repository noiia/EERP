// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bff', () => ({ forwardedFor: async () => ({ 'X-Forwarded-For': '9.9.9.9' }) }))

import { GET } from './route'

afterEach(() => vi.unstubAllGlobals())

describe('GET /api/site-events/upcoming', () => {
  it('relays limit and near to Go with the visitor IP', async () => {
    process.env.API_BASE = 'http://api.test'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await GET(new Request('http://x/api/site-events/upcoming?limit=5&near=2.35%2C48.85&junk=1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [{ id: 'a' }] })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://api.test/api/v1/public/events/upcoming?limit=5&near=2.35%2C48.85')
    expect((init.headers as Record<string, string>)['X-Forwarded-For']).toBe('9.9.9.9')
  })

  it('passes a Go 400 through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad near' }), { status: 400 })))
    const res = await GET(new Request('http://x/api/site-events/upcoming?near=zzz'))
    expect(res.status).toBe(400)
  })
})
