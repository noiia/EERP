import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable cookie jar backing the mocked next/headers cookies() store. The ApiClient
// reads the access token from it on every request and writes rotated tokens on refresh.
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

const revalidateTagMock = vi.fn()
vi.mock('next/cache', () => ({
  revalidateTag: (tag: string, profile: unknown) => revalidateTagMock(tag, profile),
}))

import { createServerApiClient, onSessionExpired } from './ApiClient'
import { ApiError } from './errors'

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function authHeader(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization
}

// Go's refresh response: new access token in the body, rotated refresh token in a
// Set-Cookie header (never in the body).
function refreshResponse(access: string, rotatedRefresh: string): Response {
  return new Response(JSON.stringify({ access_token: access, token_type: 'Bearer', expires_in: 3600 }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `refresh_token=${rotatedRefresh}; Path=/; HttpOnly`,
    },
  })
}

/** Await a call expected to reject and return its ApiError. */
async function captureError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
    throw new Error('expected the call to reject')
  } catch (e) {
    return e as ApiError
  }
}

beforeEach(() => {
  cookieJar.clear()
  cookieJar.set('eerp_access', 'old')
  cookieJar.set('eerp_refresh', 'r1')
  revalidateTagMock.mockClear()
  process.env.API_BASE = 'http://api.test'
  delete process.env.API_VERSION
  onSessionExpired(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ServerApiClient', () => {
  it('lists records, joining the Data Cache with the entity tag', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, [{ id: '1' }]))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createServerApiClient().list('crm')).resolves.toEqual([{ id: '1' }])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/crm',
      expect.objectContaining({ method: 'GET', next: { tags: ['crm'] } }),
    )
  })

  it('unwraps the paginated { data } envelope from the list endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { data: [{ id: '1' }, { id: '2' }], total: 2, page: 1, page_size: 50 })),
    )
    await expect(createServerApiClient().list('crm')).resolves.toEqual([{ id: '1' }, { id: '2' }])
  })

  it('throws an ApiError carrying the envelope code on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(404, {
          error: { code: 'CONTACT_NOT_FOUND', message: 'gone', request_id: 'req-9' },
        }),
      ),
    )

    const err = await captureError(createServerApiClient().get('crm', 'x'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('CONTACT_NOT_FOUND')
    expect(err.requestId).toBe('req-9')
    expect(err.status).toBe(404)
  })

  it('synthesizes INTERNAL_ERROR on a 500 without an envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { boom: true })))

    const err = await captureError(createServerApiClient().list('crm'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('INTERNAL_ERROR')
    expect(err.status).toBe(500)
  })

  it('refreshes once and retries on a 401, rotating the cookies', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/auth/refresh')) {
        return refreshResponse('new', 'r2')
      }
      return authHeader(init) === 'Bearer new'
        ? jsonResponse(200, [{ id: '1' }])
        : jsonResponse(401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(createServerApiClient().list('crm')).resolves.toEqual([{ id: '1' }])
    expect(cookieJar.get('eerp_access')).toBe('new')
    expect(cookieJar.get('eerp_refresh')).toBe('r2')
  })

  it('clears the cookie and signals session-expired when refresh fails', async () => {
    const expired = vi.fn()
    onSessionExpired(expired)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url)
        if (u.endsWith('/auth/refresh')) {
          return jsonResponse(401, { error: { code: 'REFRESH_REUSED', message: 'theft' } })
        }
        return jsonResponse(401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } })
      }),
    )

    const err = await captureError(createServerApiClient().list('crm'))
    expect(err).toBeInstanceOf(ApiError)
    expect(cookieJar.has('eerp_access')).toBe(false)
    expect(cookieJar.has('eerp_refresh')).toBe(false)
    expect(expired).toHaveBeenCalledOnce()
  })

  it('absorbs concurrent 401s into exactly one refresh', async () => {
    let refreshCount = 0
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/auth/refresh')) {
        refreshCount += 1
        // Hold the refresh open so both 401'd requests attach to the same promise.
        await new Promise((resolve) => setTimeout(resolve, 10))
        return refreshResponse('new', 'r2')
      }
      return authHeader(init) === 'Bearer new'
        ? jsonResponse(200, [{ id: '1' }])
        : jsonResponse(401, { error: { code: 'TOKEN_EXPIRED', message: 'x' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = createServerApiClient()
    const [a, b] = await Promise.all([client.list('crm'), client.list('crm')])
    expect(a).toEqual([{ id: '1' }])
    expect(b).toEqual([{ id: '1' }])
    expect(refreshCount).toBe(1)
  })

  it('revalidates the entity tag after a create', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { id: '1', name: 'A' })))

    await createServerApiClient().create('crm', { name: 'A' })
    expect(revalidateTagMock).toHaveBeenCalledWith('crm', 'max')
  })

  it('revalidates after a soft-delete (204)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(204)))

    await expect(createServerApiClient().remove('crm', '1')).resolves.toBeUndefined()
    expect(revalidateTagMock).toHaveBeenCalledWith('crm', 'max')
  })

  it('honors API_VERSION when set', async () => {
    process.env.API_VERSION = '2'
    const fetchMock = vi.fn(async () => jsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await createServerApiClient().list('crm')
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v2/crm', expect.anything())
  })
})
