// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bff', () => ({ forwardedFor: async () => ({ 'X-Forwarded-For': '9.9.9.9' }) }))
const getJSON = vi.fn()
vi.mock('@/website/public-api', () => ({ getJSON: (...a: unknown[]) => getJSON(...a) }))

import { GET } from './route'

const call = (q: string, page = 'p1', block = 's1') =>
  GET(new Request(`http://x/api/site-search/${page}/${block}?q=${encodeURIComponent(q)}`), { params: Promise.resolve({ page, block }) })

afterEach(() => { vi.unstubAllGlobals(); getJSON.mockReset() })

describe('GET /api/site-search/:page/:block', () => {
  it("searches the tables of the published page's block, never ones from the request", async () => {
    process.env.API_BASE = 'http://api.test'
    getJSON.mockResolvedValue({ layout: [{ id: 's1', type: 'search', config: { targets: [{ table: 'product', title_field: 'name' }] } }] })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a', name: 'Chair' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await call('cha')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ groups: [{ table: 'product', label: 'product', hits: [{ id: 'a', title: 'Chair' }] }] })
    expect(getJSON).toHaveBeenCalledWith('/website_page/p1', ['website_page'])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://api.test/api/v1/public/product?page_size=5&order=name&search%5Bname%5D=cha')
    expect((init.headers as Record<string, string>)['X-Forwarded-For']).toBe('9.9.9.9')
  })

  it('404s for an unpublished page or a block that is not a search block', async () => {
    getJSON.mockResolvedValue(null)
    expect((await call('abc')).status).toBe(404)
    getJSON.mockResolvedValue({ layout: [{ id: 's1', type: 'text', config: {} }] })
    expect((await call('abc')).status).toBe(404)
  })

  it('leaves out a table Go refuses', async () => {
    getJSON.mockResolvedValue({ layout: [{ id: 's1', type: 'search', config: { targets: [{ table: 'secret', title_field: 'name' }] } }] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    expect(await (await call('abc')).json()).toEqual({ groups: [] })
  })
})
