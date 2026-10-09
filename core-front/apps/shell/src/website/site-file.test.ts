import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { relaySiteFile } from './site-file'

describe('relaySiteFile', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubEnv('API_BASE', 'http://go')
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('asks Go for robots.txt for the request host and relays it as cacheable text', async () => {
    fetchMock.mockResolvedValue(new Response('User-agent: *\nDisallow: /\n', { status: 200 }))
    const res = await relaySiteFile(
      new Request('http://x/robots.txt', {
        headers: { host: 'erp.acme.fr', 'x-forwarded-for': '1.2.3.4' },
      }),
      'robots.txt',
    )
    expect(fetchMock.mock.calls[0][0]).toBe('http://go/api/v1/public/robots.txt?host=erp.acme.fr')
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'X-Forwarded-For': '1.2.3.4' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n')
  })

  it('relays a 404 (no security.txt set) uncached', async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"no security.txt"}', { status: 404 }))
    const res = await relaySiteFile(
      new Request('http://x/.well-known/security.txt'),
      'security.txt',
    )
    expect(fetchMock.mock.calls[0][0]).toBe('http://go/api/v1/public/security.txt')
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('answers 503 when Go is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    expect((await relaySiteFile(new Request('http://x/robots.txt'), 'robots.txt')).status).toBe(503)
  })
})
