import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// The visitor's IP, as the gateway reported it to Next.
const visitor = vi.hoisted(() => ({ ip: '198.51.100.4' }))
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': visitor.ip }) }))

// unstable_cache stand-in: keyed by keyParts only (like Next), rejections not cached.
const cache = vi.hoisted(() => ({ entries: new Map<string, unknown>(), tags: [] as string[][] }))
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[], opts: { tags: string[] }) => async () => {
    cache.tags.push(opts.tags)
    const key = JSON.stringify(keyParts)
    if (!cache.entries.has(key)) cache.entries.set(key, await fn())
    return cache.entries.get(key)
  },
}))
import { getMenuPages, getSitePage, serverPublicSource } from './public-api'

beforeEach(() => {
  process.env.API_BASE = 'http://api.test'
  visitor.ip = '198.51.100.4'
  cache.entries.clear()
  cache.tags = []
})
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

it('getSitePage: home ("") is queried with empty[slug]=1; null layout becomes []', async () => {
  const fetchMock = json([{ id: 'h', slug: '', title: 'Home', layout: null }])
  vi.stubGlobal('fetch', fetchMock)
  const home = await getSitePage('')
  expect(home).toMatchObject({ id: 'h', layout: [] })
  expect(String(fetchMock.mock.calls[0][0])).toBe('http://api.test/api/v1/public/website_page?page_size=1&empty%5Bslug%5D=1')
})

it('forwards the visitor IP (Go rate-limits /public per client IP)', async () => {
  const fetchMock = json([])
  vi.stubGlobal('fetch', fetchMock)
  await serverPublicSource.list('product', {})
  const init = fetchMock.mock.calls[0][1] as RequestInit
  expect((init.headers as Record<string, string>)['X-Forwarded-For']).toBe('198.51.100.4')
})

it('a 429 empties a block (null) but fails the page fetch itself', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })))
  expect(await serverPublicSource.list('product', {})).toBeNull()
  expect(await serverPublicSource.get('product', '1')).toBeNull()
  expect(await getMenuPages()).toEqual([])
  await expect(getSitePage('about')).rejects.toThrow('429')
})

it('getMenuPages sorts by menu_sequence, null as 0', async () => {
  vi.stubGlobal('fetch', json([
    { slug: 'b', title: 'B', menu_sequence: 2 },
    { slug: 'a', title: 'A', menu_sequence: null },
  ]))
  expect((await getMenuPages()).map((p) => p.slug)).toEqual(['a', 'b'])
})

it('encodes table and id path segments', async () => {
  const fetchMock = json([])
  vi.stubGlobal('fetch', fetchMock)
  await serverPublicSource.get('a b', '../x')
  expect(String(fetchMock.mock.calls[0][0])).toBe('http://api.test/api/v1/public/a%20b/..%2Fx')
})

it('the cache is shared across visitor IPs (the IP is not part of the key); tags kept', async () => {
  const fetchMock = json([{ id: '1' }])
  vi.stubGlobal('fetch', fetchMock)
  await serverPublicSource.list('product', {})
  visitor.ip = '203.0.113.50'
  expect(await serverPublicSource.list('product', {})).toEqual({ records: [{ id: '1' }], total: 1 })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect((fetchMock.mock.calls[0][1] as RequestInit).cache).toBe('no-store')
  expect(cache.tags[0]).toEqual(['website_page', 'product'])
})

it('a 429 is never cached: the next call fetches again', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 429 }))
  vi.stubGlobal('fetch', fetchMock)
  expect(await serverPublicSource.list('product', {})).toBeNull()
  expect(await serverPublicSource.list('product', {})).toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
