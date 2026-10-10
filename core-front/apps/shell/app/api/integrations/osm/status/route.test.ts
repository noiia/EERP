import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'eerp_access' ? { name, value: 'TOKEN' } : undefined),
    set: () => {},
    delete: () => {},
  }),
}))

import { GET } from './route'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  process.env.API_BASE = 'http://api.test'
  delete process.env.API_VERSION
})
afterEach(() => vi.unstubAllGlobals())

describe('GET /api/integrations/osm/status', () => {
  it('is enabled when the connector is on with a base URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ enabled: true, base_url: 'https://osm.test', user_agent: 'x' })),
    )
    await expect((await GET()).json()).resolves.toEqual({ enabled: true })
  })

  it('is disabled when the connector is off, has no base URL, or cannot be read', async () => {
    for (const res of [
      json({ enabled: false, base_url: 'https://osm.test', user_agent: '' }),
      json({ enabled: true, base_url: '', user_agent: '' }),
      json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403),
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => res),
      )
      await expect((await GET()).json()).resolves.toEqual({ enabled: false })
    }
  })
})
