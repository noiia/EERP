import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable cookie jar backing the mocked next/headers cookies() store. The ApiClient
// reads the access token from it on every request and writes rotated tokens on refresh.
const cookieJar = new Map<string, string>()

// When true, the mocked store throws the same error Next.js throws for a
// cookies().set()/delete() call made during a Server Component render (as opposed to
// a Route Handler/Server Action) — simulates the RSC-render call path.
let forbidCookieWrites = false
const COOKIE_WRITE_FORBIDDEN =
  'Cookies can only be modified in a Server Action or Route Handler. Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#options'

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set: (name: string, value: string) => {
      if (forbidCookieWrites) throw new Error(COOKIE_WRITE_FORBIDDEN)
      cookieJar.set(name, value)
    },
    delete: (name: string) => {
      if (forbidCookieWrites) throw new Error(COOKIE_WRITE_FORBIDDEN)
      cookieJar.delete(name)
    },
  }),
}))

const revalidateTagMock = vi.fn()
vi.mock('next/cache', () => ({
  revalidateTag: (tag: string, profile: unknown) => revalidateTagMock(tag, profile),
}))

import { apiRequest, createServerApiClient, onSessionExpired } from './ApiClient'
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
  forbidCookieWrites = false
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

  it('listWithTotal surfaces the paginated envelope\'s total row count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { data: [{ id: '1' }], total: 500, page: 1, page_size: 20 })),
    )
    await expect(createServerApiClient().listWithTotal('crm')).resolves.toEqual({
      records: [{ id: '1' }],
      total: 500,
    })
  })

  it('listWithTotal falls back to records.length when the response is a bare array (no total)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, [{ id: '1' }, { id: '2' }])))
    await expect(createServerApiClient().listWithTotal('crm')).resolves.toEqual({
      records: [{ id: '1' }, { id: '2' }],
      total: 2,
    })
  })

  it('list() discards the total, matching its existing T[] contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { data: [{ id: '1' }], total: 500, page: 1, page_size: 20 })),
    )
    await expect(createServerApiClient().list('crm')).resolves.toEqual([{ id: '1' }])
  })

  it('encodes list options as filter[]/search[] query params', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await createServerApiClient().list('contact', {
      filter: { crm_id: 'r1' },
      search: { name: 'ada' },
      pageSize: 10,
    })

    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    const query = new URL(url).searchParams
    expect(url.startsWith('http://api.test/api/v1/contact?')).toBe(true)
    expect(query.get('filter[crm_id]')).toBe('r1')
    expect(query.get('search[name]')).toBe('ada')
    expect(query.get('page_size')).toBe('10')
    // Filtered reads still join the entity's cache tag (mutations revalidate them).
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ next: { tags: ['contact'] } }),
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

  it('fails closed on a 401 during an RSC render instead of refreshing', async () => {
    // Simulates a Server Component read (list()/get() called from a page/layout, not
    // a Route Handler or Server Action): cookies() can't be written here, so a real
    // refresh attempt would either throw on the write or spend Go's single-use
    // refresh token with no way to persist the rotation. It should fail closed —
    // surface the 401 as-is, never call /auth/refresh, never touch the cookies.
    forbidCookieWrites = true
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/auth/refresh')) throw new Error('must not be called during an RSC render')
      return jsonResponse(401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const err = await captureError(createServerApiClient().list('crm'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('TOKEN_EXPIRED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Untouched — the mocked store never accepted a write either way.
    expect(cookieJar.get('eerp_access')).toBe('old')
    expect(cookieJar.get('eerp_refresh')).toBe('r1')
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

  it('reads Kanban/Calendar field config, never caching (tenant-wide settings)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { kanban_status_field: 'status', calendar_date_field: null }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(createServerApiClient().getViewFields('crm')).resolves.toEqual({
      kanbanStatusField: 'status',
      calendarDateField: null,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { next?: unknown }]
    expect(url).toBe('http://api.test/api/v1/settings/views/crm/fields')
    expect(init.cache).toBe('no-store')
    expect(init.next).toBeUndefined()
  })

  it('reads a module\'s picture-size setting, never caching', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { size: { width: 200, height: 150 } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createServerApiClient().getPictureSize('crm')).resolves.toEqual({
      width: 200,
      height: 150,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { next?: unknown }]
    expect(url).toBe('http://api.test/api/v1/settings/apps/crm/picture-size')
    expect(init.cache).toBe('no-store')
    expect(init.next).toBeUndefined()
  })

  it('reads null when a module has no picture-size override configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { size: null })))
    await expect(createServerApiClient().getPictureSize('crm')).resolves.toBeNull()
  })

  it('apiRequest GETs stay out of the Data Cache (session-scoped, never shared)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { preferred_locale: 'fr', default_locale: null }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiRequest('GET', '/me/preferences')).resolves.toEqual({
      preferred_locale: 'fr',
      default_locale: null,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { next?: unknown }]
    expect(url).toBe('http://api.test/api/v1/me/preferences')
    expect(authHeader(init)).toBe('Bearer old')
    expect(init.cache).toBe('no-store')
    expect(init.next).toBeUndefined()
  })

  it('apiRequest resolves undefined on 204 and refreshes once on 401', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/auth/refresh')) return refreshResponse('new', 'r2')
      return authHeader(init) === 'Bearer new'
        ? jsonResponse(204)
        : jsonResponse(401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      apiRequest('PUT', '/me/preferences', { preferred_locale: 'fr' }),
    ).resolves.toBeUndefined()
    expect(cookieJar.get('eerp_access')).toBe('new')
  })

  it('honors API_VERSION when set', async () => {
    process.env.API_VERSION = '2'
    const fetchMock = vi.fn(async () => jsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await createServerApiClient().list('crm')
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v2/crm', expect.anything())
  })

  // createServerApiClient(tokenOverride) — the PDF print route's path (docs/adr/
  // ADR-010): a Server Component rendering for pdf-service's headless Chrome has no
  // session cookie at all, only a short-lived token Go minted into the URL.
  describe('tokenOverride', () => {
    it('sends the override as the Bearer token instead of reading the cookie', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(200, { id: '1' }))
      vi.stubGlobal('fetch', fetchMock)

      await createServerApiClient('short-lived-token').get('contact', '1')

      expect(authHeader(fetchMock.mock.calls[0]?.[1] as RequestInit)).toBe('Bearer short-lived-token')
      // The cookie jar has 'old' seeded in beforeEach — proving the override
      // wins, not just that some token was sent.
    })

    it('never reads the session cookie when an override is supplied', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(200, { id: '1' }))
      vi.stubGlobal('fetch', fetchMock)
      cookieJar.set('eerp_access', 'should-never-be-used')

      await createServerApiClient('short-lived-token').get('contact', '1')

      expect(authHeader(fetchMock.mock.calls[0]?.[1] as RequestInit)).toBe('Bearer short-lived-token')
    })

    it('fails closed on a 401 instead of attempting a cookie refresh', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } }))
      vi.stubGlobal('fetch', fetchMock)

      const err = await captureError(createServerApiClient('expired-token').get('contact', '1'))
      expect(err.code).toBe('UNAUTHENTICATED')
      // Exactly one call — no refresh attempt, no retry.
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('with no argument, behaves exactly like the cookie-bound client (default unchanged)', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(200, { id: '1' }))
      vi.stubGlobal('fetch', fetchMock)

      await createServerApiClient().get('contact', '1')

      expect(authHeader(fetchMock.mock.calls[0]?.[1] as RequestInit)).toBe('Bearer old')
    })
  })
})
