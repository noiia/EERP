// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const proxyExchange = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eerp/core-front/server')>()),
  proxyExchange: (...args: unknown[]) => proxyExchange(...args),
}))

import { GET, POST } from './route'

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) })

const VALID = ['project', 'p1', 'gan', 'export']

describe('/api/exchange/[[...path]]', () => {
  it('relays the status, body and Content-Disposition of an export download', async () => {
    proxyExchange.mockResolvedValue(
      new Response('<project/>', {
        status: 200,
        headers: {
          'content-disposition': 'attachment; filename="Design review.gan"',
          'content-type': 'application/xml',
        },
      }),
    )
    const res = await GET(new Request('http://x/api/exchange/project/p1/gan/export'), ctx(...VALID))
    expect(proxyExchange).toHaveBeenCalledWith('GET', '/project/p1/exchange/gan/export', undefined)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="Design review.gan"')
    expect(res.headers.get('Content-Type')).toBe('application/xml')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(res.text()).resolves.toBe('<project/>')
  })

  it('relays Go refusal untouched (a stale base is a 409 PROJECT_CHANGED)', async () => {
    proxyExchange.mockResolvedValue(
      new Response('{"error":{"code":"PROJECT_CHANGED","message":"the project changed since the preview"}}', {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const res = await GET(new Request('http://x/api/exchange/project/p1/gan/export'), ctx(...VALID))
    expect(res.status).toBe(409)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    await expect(res.json()).resolves.toEqual({
      error: { code: 'PROJECT_CHANGED', message: 'the project changed since the preview' },
    })
  })

  it('forwards a preview POST as multipart FormData, file included', async () => {
    proxyExchange.mockResolvedValue(new Response('{"base":"h","changes":[],"warnings":[]}'))
    const form = new FormData()
    form.append('file', new Blob(['<project/>'], { type: 'application/xml' }), 'plan.gan')
    await POST(
      new Request('http://x/api/exchange/project/p1/gan/preview', { method: 'POST', body: form }),
      ctx('project', 'p1', 'gan', 'preview'),
    )
    expect(proxyExchange).toHaveBeenCalledWith('POST', '/project/p1/exchange/gan/preview', expect.any(FormData))
    const sent = proxyExchange.mock.calls.at(-1)![2] as FormData
    const file = sent.get('file') as File
    expect(file.name).toBe('plan.gan')
    await expect(file.text()).resolves.toBe('<project/>')
  })

  it('forwards an apply POST with its base and repeated keys', async () => {
    proxyExchange.mockResolvedValue(new Response('{"applied":2}', { status: 200 }))
    const form = new FormData()
    form.append('file', new Blob(['<project/>'], { type: 'application/xml' }), 'plan.gan')
    form.append('base', 'abc123')
    form.append('keys', 'task:1:dates')
    form.append('keys', 'new:7')
    await POST(
      new Request('http://x/api/exchange/project/p1/gan/apply', { method: 'POST', body: form }),
      ctx('project', 'p1', 'gan', 'apply'),
    )
    const sent = proxyExchange.mock.calls.at(-1)![2] as FormData
    expect(sent.get('base')).toBe('abc123')
    expect(sent.getAll('keys')).toEqual(['task:1:dates', 'new:7'])
  })

  it('re-encodes the segments it forwards', async () => {
    proxyExchange.mockResolvedValue(new Response(null, { status: 204 }))
    await GET(new Request('http://x/api/exchange/project/a%20b/gan/export'), ctx('project', 'a b', 'gan', 'export'))
    expect(proxyExchange).toHaveBeenCalledWith('GET', '/project/a%20b/exchange/gan/export', undefined)
  })

  it('rejects a .. segment with a 400 and never calls Go', async () => {
    proxyExchange.mockClear()
    const res = await GET(new Request('http://x/api/exchange/project/../gan/export'), ctx('project', '..', 'gan', 'export'))
    expect(res.status).toBe(400)
    expect(proxyExchange).not.toHaveBeenCalled()
  })

  it('rejects a path that is not exactly 4 segments with a 400', async () => {
    proxyExchange.mockClear()
    expect((await GET(new Request('http://x/api/exchange/project/p1/gan'), ctx('project', 'p1', 'gan'))).status).toBe(400)
    expect((await GET(new Request('http://x/api/exchange'), ctx())).status).toBe(400)
    expect(
      (
        await GET(
          new Request('http://x/api/exchange/project/p1/gan/export/extra'),
          ctx('project', 'p1', 'gan', 'export', 'extra'),
        )
      ).status,
    ).toBe(400)
    expect(proxyExchange).not.toHaveBeenCalled()
  })

  it('rejects an action outside export/preview/apply with a 400', async () => {
    proxyExchange.mockClear()
    for (const action of ['delete', 'Export', 'apply-all']) {
      const res = await POST(
        new Request(`http://x/api/exchange/project/p1/gan/${action}`, { method: 'POST' }),
        ctx('project', 'p1', 'gan', action),
      )
      expect(res.status).toBe(400)
    }
    expect(proxyExchange).not.toHaveBeenCalled()
  })
})
