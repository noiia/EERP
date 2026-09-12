import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cookieJar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set: (name: string, value: string) => {
      cookieJar.set(name, value)
    },
    delete: (name: string) => {
      cookieJar.delete(name)
    },
  }),
}))

import { POST } from './[name]/[id]/route'
import { GET } from './pdf/route'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  cookieJar.clear()
  cookieJar.set('eerp_access', 'TOKEN')
  process.env.API_BASE = 'http://api.test'
  delete process.env.API_VERSION
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/reports/:name/:id', () => {
  it('forwards to Go with the session Bearer and translates download_url to this BFF\'s own path', async () => {
    const goFetch = vi.fn(async () =>
      jsonResponse({ download_url: '/api/v1/reports/pdf?key=reports%2Ft1%2Fcrm.statement%2Fr1%2F1.pdf' }, 201),
    )
    vi.stubGlobal('fetch', goFetch)

    const res = await POST(new Request('http://localhost/api/reports/crm.statement/r1', { method: 'POST' }), {
      params: Promise.resolve({ name: 'crm.statement', id: 'r1' }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    // A Next-side proxy path, NOT Go's own /api/v1/... path — the browser
    // must never be handed something it needs a Bearer header to reach.
    expect(body.download_url).toBe('/api/reports/pdf?key=reports%2Ft1%2Fcrm.statement%2Fr1%2F1.pdf')

    const [url, init] = goFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://api.test/api/v1/reports/crm.statement/r1/pdf')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN')
    expect(init.method).toBe('POST')
  })

  it('relays a Go failure (e.g. render failed) as the same error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'RENDER_FAILED', message: 'Could not generate the report.' } }, 502),
      ),
    )
    const res = await POST(new Request('http://localhost/api/reports/crm.statement/r1', { method: 'POST' }), {
      params: Promise.resolve({ name: 'crm.statement', id: 'r1' }),
    })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.code).toBe('RENDER_FAILED')
  })
})

describe('GET /api/reports/pdf (stream)', () => {
  it('streams the PDF bytes through with the session Bearer attached', async () => {
    const goFetch = vi.fn(async () =>
      new Response('%PDF-bytes', { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
    )
    vi.stubGlobal('fetch', goFetch)

    const res = await GET(new Request('http://localhost/api/reports/pdf?key=reports%2Ft1%2Fx%2Fy%2F1.pdf'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    await expect(res.text()).resolves.toBe('%PDF-bytes')

    const [url, init] = goFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://api.test/api/v1/reports/pdf?key=reports%2Ft1%2Fx%2Fy%2F1.pdf')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN')
  })

  it('maps a missing/foreign-tenant key to the 404 envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'NOT_FOUND', message: 'No such report.' } }, 404)),
    )
    const res = await GET(new Request('http://localhost/api/reports/pdf?key=nope'))
    expect(res.status).toBe(404)
  })
})
