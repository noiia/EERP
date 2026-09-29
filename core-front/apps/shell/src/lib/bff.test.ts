import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const incoming = vi.hoisted(() => ({ headers: new Headers() as Headers | null }))
vi.mock('next/headers', () => ({
  headers: async () => {
    if (!incoming.headers) throw new Error('outside a request scope')
    return incoming.headers
  },
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}))

import { goAuthExchange, goLogout } from './bff'

const fetchMock = vi.fn()
const sentHeaders = () => fetchMock.mock.calls[0][1].headers as Record<string, string>

beforeEach(() => {
  vi.stubEnv('API_BASE', 'http://go')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ access_token: 'A' }), { status: 200 }))
  incoming.headers = new Headers()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

// Go's rate limiters key on the client IP: without this every visitor shares
// the BFF's own address, i.e. one global bucket.
describe('client IP forwarding', () => {
  it('forwards the incoming x-forwarded-for', async () => {
    incoming.headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 172.18.0.2', 'x-real-ip': '198.51.100.1' })
    await goAuthExchange('login', {}, 'website/auth')
    expect(sentHeaders()['X-Forwarded-For']).toBe('203.0.113.7, 172.18.0.2')
  })

  it('falls back to x-real-ip', async () => {
    incoming.headers = new Headers({ 'x-real-ip': '198.51.100.1' })
    await goLogout('R', 'website/auth')
    expect(sentHeaders()['X-Forwarded-For']).toBe('198.51.100.1')
  })

  it('sends nothing when there is no client IP or no request scope', async () => {
    await goAuthExchange('refresh', {})
    expect(sentHeaders()).not.toHaveProperty('X-Forwarded-For')
    fetchMock.mockClear()
    incoming.headers = null
    await goAuthExchange('refresh', {})
    expect(sentHeaders()).not.toHaveProperty('X-Forwarded-For')
  })
})
