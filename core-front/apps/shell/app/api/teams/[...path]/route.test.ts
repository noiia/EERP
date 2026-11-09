// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const proxyTeams = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eerp/core-front/server')>()),
  proxyTeams: (...args: unknown[]) => proxyTeams(...args),
}))

import { DELETE, GET, POST } from './route'

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) })

describe('/api/teams/[...path]', () => {
  it('forwards method, path and query', async () => {
    proxyTeams.mockResolvedValue(new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }))
    const res = await GET(new Request('http://x/api/teams/t1/files?folder=f1'), ctx('t1', 'files'))
    expect(proxyTeams).toHaveBeenCalledWith('GET', '/t1/files?folder=f1', undefined)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: [] })
  })

  it('forwards a JSON body and a multipart body', async () => {
    proxyTeams.mockResolvedValue(new Response(null, { status: 204 }))
    await POST(
      new Request('http://x/api/teams/direct', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"user_id":"u"}' }),
      ctx('direct'),
    )
    expect(proxyTeams).toHaveBeenLastCalledWith('POST', '/direct', { user_id: 'u' })
    const form = new FormData()
    form.append('body', 'hi')
    await POST(new Request('http://x/api/teams/channels/c/messages', { method: 'POST', body: form }), ctx('channels', 'c', 'messages'))
    const sent = proxyTeams.mock.calls.at(-1)![2] as FormData
    expect(sent.get('body')).toBe('hi')
  })

  it('rejects .. segments and re-encodes others', async () => {
    proxyTeams.mockClear()
    expect((await DELETE(new Request('http://x/api/teams/a'), ctx('a', '..'))).status).toBe(400)
    expect(proxyTeams).not.toHaveBeenCalled()
    proxyTeams.mockResolvedValue(new Response(null, { status: 204 }))
    await DELETE(new Request('http://x/api/teams/a', { method: 'DELETE' }), ctx('a b'))
    expect(proxyTeams).toHaveBeenCalledWith('DELETE', '/a%20b', undefined)
  })

  it('passes content-disposition and status through', async () => {
    proxyTeams.mockResolvedValue(
      new Response('bytes', { status: 200, headers: { 'content-disposition': 'attachment; filename="a.pdf"', 'content-type': 'application/pdf' } }),
    )
    const res = await GET(new Request('http://x/api/teams/files/f/download'), ctx('files', 'f', 'download'))
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="a.pdf"')
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    proxyTeams.mockResolvedValue(new Response('{"error":{"message":"no"}}', { status: 404 }))
    expect((await GET(new Request('http://x/api/teams/zz'), ctx('zz'))).status).toBe(404)
  })
})
