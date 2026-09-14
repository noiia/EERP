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

import { GET, POST } from './route'
import { DELETE, GET as GET_ONE } from './[id]/route'

const meta = {
  id: 'p1',
  table_name: 'contact',
  record_id: 'r1',
  field: 'photo',
  mime: 'image/png',
  size: 3,
}

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

describe('POST /api/pictures', () => {
  it('forwards the multipart form to Go with the session Bearer', async () => {
    const goFetch = vi.fn(async () => jsonResponse(meta, 201))
    vi.stubGlobal('fetch', goFetch)

    const form = new FormData()
    form.set('table_name', 'contact')
    form.set('record_id', 'r1')
    form.set('field', 'photo')
    form.set('file', new Blob(['png'], { type: 'image/png' }), 'photo.png')
    const res = await POST(new Request('http://localhost/api/pictures', { method: 'POST', body: form }))

    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toEqual(meta)

    const [url, init] = goFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://api.test/api/v1/pictures')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN')
    // Tag check, not instanceof: the parsed request FormData is undici's, not the test realm's.
    expect(Object.prototype.toString.call(init.body)).toBe('[object FormData]')
    const forwarded = init.body as FormData
    expect(forwarded.get('table_name')).toBe('contact')
    expect(forwarded.get('record_id')).toBe('r1')
    expect(forwarded.get('field')).toBe('photo')
    // fetch must derive the multipart boundary itself — a manual Content-Type corrupts the body.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('relays the Go error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'bad', request_id: 'r' } }, 400),
      ),
    )
    const res = await POST(new Request('http://localhost/api/pictures', { method: 'POST', body: new FormData() }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('GET /api/pictures (anchor lookup)', () => {
  it('returns the metadata for an anchored picture', async () => {
    const goFetch = vi.fn(async () => jsonResponse(meta))
    vi.stubGlobal('fetch', goFetch)

    const res = await GET(
      new Request('http://localhost/api/pictures?table=contact&record=r1&field=photo'),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(meta)
    const [url] = goFetch.mock.calls[0] as unknown as [string]
    expect(url).toBe('http://api.test/api/v1/pictures?table=contact&record=r1&field=photo')
  })

  it('propagates the empty anchor as 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'NOT_FOUND', message: 'none' } }, 404)),
    )
    const res = await GET(
      new Request('http://localhost/api/pictures?table=contact&record=r1&field=photo'),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

describe('GET /api/pictures/:id (stream)', () => {
  it('streams the bytes and mime through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('image-bytes', { status: 200, headers: { 'Content-Type': 'image/png' } })),
    )
    const res = await GET_ONE(new Request('http://localhost/api/pictures/p1'), {
      params: Promise.resolve({ id: 'p1' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    await expect(res.text()).resolves.toBe('image-bytes')
  })

  it('maps a missing picture to the envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'NOT_FOUND', message: 'none' } }, 404)),
    )
    const res = await GET_ONE(new Request('http://localhost/api/pictures/p1'), {
      params: Promise.resolve({ id: 'p1' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/pictures/:id', () => {
  it('deletes through Go and returns 204', async () => {
    const goFetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', goFetch)

    const res = await DELETE(new Request('http://localhost/api/pictures/p1', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'p1' }),
    })
    expect(res.status).toBe(204)
    const [url, init] = goFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://api.test/api/v1/pictures/p1')
    expect(init.method).toBe('DELETE')
  })
})
