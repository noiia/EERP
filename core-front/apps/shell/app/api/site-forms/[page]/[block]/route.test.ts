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

import { POST } from './route'

const body = JSON.stringify({ values: { name: 'Vi' } })
const call = (page = 'p1', block = 'b1') =>
  POST(new Request(`http://localhost/api/site-forms/${page}/${block}`, { method: 'POST', body }), { params: Promise.resolve({ page, block }) })
const sent = (fetchMock: { mock: { calls: Parameters<typeof fetch>[] } }, i: number) =>
  fetchMock.mock.calls[i][1] as RequestInit & { headers: Record<string, string> }

beforeEach(() => {
  cookieJar.clear()
  process.env.API_BASE = 'http://api.test'
  delete process.env.API_VERSION
})
afterEach(() => vi.unstubAllGlobals())

describe('POST /api/site-forms/:page/:block', () => {
  it('forwards anonymously, or with the site token when logged in — never the ERP token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    cookieJar.set('eerp_access', 'erp-token')

    const res = await call()
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/v1/website/forms/p1/b1')
    expect(sent(fetchMock, 0).method).toBe('POST')
    expect(sent(fetchMock, 0).headers).not.toHaveProperty('Authorization')
    expect(sent(fetchMock, 0).headers['X-Forwarded-For']).toBe('198.51.100.4')
    expect(sent(fetchMock, 0).body).toBe(body)

    cookieJar.set('eerp_site_access', 'site-token')
    await call()
    expect(sent(fetchMock, 1).headers.Authorization).toBe('Bearer site-token')
  })

  it('encodes the path segments', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await call('../x', 'a/b')
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/v1/website/forms/..%2Fx/a%2Fb')
  })

  it("passes a 422 through with Go's envelope", async () => {
    const envelope = { error: { code: 'VALIDATION_ERROR', message: 'bad', fields: ['email'] } }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify(envelope), { status: 422 })))
    const res = await call()
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual(envelope)
  })

  it('answers 502 when Go is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    expect((await call()).status).toBe(502)
  })
})
