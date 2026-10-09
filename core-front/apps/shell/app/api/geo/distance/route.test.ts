// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const server = vi.hoisted(() => ({ apiRequest: vi.fn() }))
vi.mock('@eerp/core-front/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eerp/core-front/server')>()),
  apiRequest: server.apiRequest,
}))

import { GET } from './route'

const url = `http://x/api/geo/distance?from=${encodeURIComponent('contact:c1:geo_location')}&to=${encodeURIComponent('event:e1:geo_location')}`

beforeEach(() => server.apiRequest.mockReset())

describe('GET /api/geo/distance', () => {
  it('forwards both references to Go and relays the body', async () => {
    server.apiRequest.mockResolvedValue({ meters: 12400 })
    const res = await GET(new Request(url))
    expect(server.apiRequest).toHaveBeenCalledWith(
      'GET',
      '/geo/distance?from=contact%3Ac1%3Ageo_location&to=event%3Ae1%3Ageo_location',
    )
    expect(await res.json()).toEqual({ meters: 12400 })
  })

  it('relays Go error statuses', async () => {
    server.apiRequest.mockRejectedValueOnce(
      new ApiError({ code: 'NOT_FOUND', message: 'nope', status: 404 }),
    )
    const res = await GET(new Request(url))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ meters: null })
  })
})
