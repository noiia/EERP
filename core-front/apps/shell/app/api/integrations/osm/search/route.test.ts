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

import { GET } from './route'

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

describe('GET /api/integrations/osm/search', () => {
  it('returns no results for an empty query, without even reading the connector config', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await GET(new Request('http://localhost/api/integrations/osm/search?q='))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ results: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns no results when the connector is disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ enabled: false, base_url: '', user_agent: '' })),
    )
    const res = await GET(new Request('http://localhost/api/integrations/osm/search?q=paris'))
    await expect(res.json()).resolves.toEqual({ results: [] })
  })

  it('queries the configured Nominatim endpoint with the User-Agent header, normalizing results', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('http://api.test/')) {
        return jsonResponse({
          enabled: true,
          base_url: 'https://nominatim.example.org',
          user_agent: 'eerp/1.0',
        })
      }
      return jsonResponse([
        {
          display_name: '12 Main Street, Springfield, USA',
          address: {
            house_number: '12',
            road: 'Main Street',
            postcode: '00000',
            city: 'Springfield',
            state: 'Someplace',
            country: 'USA',
          },
        },
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(new Request('http://localhost/api/integrations/osm/search?q=12+main'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toEqual([
      {
        label: '12 Main Street, Springfield, USA',
        number: 12,
        street: 'Main Street',
        complement: '',
        zip_code: '00000',
        city: 'Springfield',
        state: 'Someplace',
        country: 'USA',
      },
    ])

    const upstreamCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith('https://nominatim.example.org'),
    )
    expect(upstreamCall).toBeDefined()
    const [upstreamURL, upstreamInit] = upstreamCall as unknown as [string, RequestInit]
    expect(upstreamURL).toContain('q=12+main')
    expect((upstreamInit.headers as Record<string, string>)['User-Agent']).toBe('eerp/1.0')
  })

  it('degrades to no results when the upstream fetch fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('http://api.test/')) {
        return jsonResponse({ enabled: true, base_url: 'https://nominatim.example.org', user_agent: '' })
      }
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await GET(new Request('http://localhost/api/integrations/osm/search?q=paris'))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ results: [] })
  })
})
