// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { GET as authorizationServer } from '../../app/.well-known/oauth-authorization-server/route'
import { GET as protectedResource } from '../../app/.well-known/oauth-protected-resource/[[...path]]/route'

beforeEach(() => {
  process.env.API_BASE = 'http://api.test'
})
afterEach(() => vi.unstubAllGlobals())

describe('OAuth metadata relays', () => {
  it('relay Go’s documents, readable from any origin', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response('{"issuer":"https://erp.test"}'))
    vi.stubGlobal('fetch', fetchMock)
    const res = await authorizationServer()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ issuer: 'https://erp.test' })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/v1/oauth/metadata/authorization-server')
    await protectedResource()
    expect(fetchMock.mock.calls[1][0]).toBe('http://api.test/api/v1/oauth/metadata/protected-resource')
  })

  it('answer 404 while OAuth is off and 503 when Go is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    expect((await protectedResource()).status).toBe(404)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect((await authorizationServer()).status).toBe(503)
  })
})
