import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cookieJar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
  }),
  headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.4' }),
}))
const revalidateTag = vi.hoisted(() => vi.fn())
vi.mock('next/cache', () => ({ revalidateTag }))

import { POST } from './route'

const req = (body = JSON.stringify({ event_id: 'e', seats: 1 })) =>
  new Request('http://localhost/api/site-booking', { method: 'POST', body })
const sent = (fetchMock: { mock: { calls: Parameters<typeof fetch>[] } }, i: number) =>
  fetchMock.mock.calls[i][1] as RequestInit & { headers: Record<string, string> }

beforeEach(() => {
  cookieJar.clear()
  revalidateTag.mockClear()
  process.env.API_BASE = 'http://api.test'
  delete process.env.API_VERSION
})
afterEach(() => vi.unstubAllGlobals())

describe('POST /api/site-booking', () => {
  it('forwards anonymously, or with the site token when logged in — never the ERP token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'b1', status: 'confirmed' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    cookieJar.set('eerp_access', 'erp-token')

    const res = await POST(req())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'b1', status: 'confirmed' })
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/v1/website/bookings')
    expect(sent(fetchMock, 0).headers).not.toHaveProperty('Authorization')
    expect(sent(fetchMock, 0).headers['X-Forwarded-For']).toBe('198.51.100.4')
    expect(sent(fetchMock, 0).body).toBe(JSON.stringify({ event_id: 'e', seats: 1 }))
    expect(revalidateTag).toHaveBeenCalledWith('event', { expire: 0 })

    cookieJar.set('eerp_site_access', 'site-token')
    await POST(req())
    expect(sent(fetchMock, 1).headers.Authorization).toBe('Bearer site-token')
  })

  it('passes a 409 through with Go\'s envelope and keeps the cache', async () => {
    const envelope = { error: { code: 'CONFLICT', message: 'no seats left' } }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify(envelope), { status: 409 })))
    const res = await POST(req('{}'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(envelope)
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('answers 502 when Go is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    expect((await POST(req())).status).toBe(502)
  })
})
