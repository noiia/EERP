import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getMenuPages, getSitePage, serverPublicSource } from './public-api'

beforeEach(() => { process.env.API_BASE = 'http://api.test' })
afterEach(() => vi.restoreAllMocks())

const json = (data: unknown[]) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data, total: data.length }), { status: 200 }))

it('lists through /api/v1/public with filters, null on 404', async () => {
  const fetchMock = json([{ id: '1' }])
  vi.stubGlobal('fetch', fetchMock)
  const res = await serverPublicSource.list('product', { filter: { published: 'true' }, page_size: 6 })
  expect(res).toEqual({ records: [{ id: '1' }], total: 1 })
  expect(String(fetchMock.mock.calls[0][0])).toBe('http://api.test/api/v1/public/product?page_size=6&filter%5Bpublished%5D=true')

  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
  expect(await serverPublicSource.list('crm', {})).toBeNull()
})

it('getSitePage: home ("") is picked from the unfiltered list; null layout becomes []', async () => {
  const fetchMock = json([{ id: 'a', slug: 'about', title: 'About', layout: [] }, { id: 'h', slug: '', title: 'Home', layout: null }])
  vi.stubGlobal('fetch', fetchMock)
  const home = await getSitePage('')
  expect(home).toMatchObject({ id: 'h', layout: [] })
  expect(String(fetchMock.mock.calls[0][0])).toBe('http://api.test/api/v1/public/website_page?page_size=50')
})

it('getMenuPages sorts by menu_sequence, null as 0', async () => {
  vi.stubGlobal('fetch', json([
    { slug: 'b', title: 'B', menu_sequence: 2 },
    { slug: 'a', title: 'A', menu_sequence: null },
  ]))
  expect((await getMenuPages()).map((p) => p.slug)).toEqual(['a', 'b'])
})
