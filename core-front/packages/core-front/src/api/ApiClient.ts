import 'server-only'
import { cookies } from 'next/headers'
import { revalidateTag } from 'next/cache'
import { ApiError, parseError } from './errors'
import {
  ACCESS_COOKIE,
  ACCESS_TTL_SECONDS,
  REFRESH_COOKIE,
  REFRESH_TTL_SECONDS,
  sessionCookieOptions,
} from './session-cookies'

// The BFF data client. Runs SERVER-SIDE only (RSC, route handlers, Server Actions)
// — the browser never calls Go directly. Reads attach the Bearer token from the
// session cookie and join the Next Data Cache via fetch tags; writes revalidate the
// entity tag so the next server render reflects the mutation.
//
// On a 401 it refreshes the session exactly once and retries once. Refresh tokens
// are single-use (rotation), so a double refresh would trip theft detection — every
// concurrent 401 therefore shares ONE in-flight refresh. A failed refresh clears the
// cookie and signals session-expired; callers (the host) redirect to /login.

function baseUrl(): string {
  const apiBase = process.env.API_BASE
  if (!apiBase) throw new Error('API_BASE is not set — the server cannot reach the backend')
  const version = process.env.API_VERSION ?? '1'
  return `${apiBase}/api/v${version}`
}

type SessionExpiredHandler = () => void | Promise<void>
let sessionExpiredHandler: SessionExpiredHandler | null = null

/** Register what happens when the session can't be refreshed (host wires a redirect). */
export function onSessionExpired(handler: SessionExpiredHandler | null): void {
  sessionExpiredHandler = handler
}

// Shared across all callers in the process: a single refresh round-trip absorbs
// every concurrent 401. Reset once settled so a later expiry can refresh again.
let inflightRefresh: Promise<boolean> | null = null

function refreshSession(): Promise<boolean> {
  if (!inflightRefresh) {
    inflightRefresh = (async (): Promise<boolean> => {
      const store = await cookies()
      const refreshToken = store.get(REFRESH_COOKIE)?.value
      if (!refreshToken) return false

      const res = await fetch(`${baseUrl()}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
        cache: 'no-store',
      })
      if (!res.ok) return false

      const data: unknown = await res.json().catch(() => null)
      const tokens = data as { access_token?: unknown; refresh_token?: unknown } | null
      if (!tokens || typeof tokens.access_token !== 'string') return false

      store.set(ACCESS_COOKIE, tokens.access_token, sessionCookieOptions(ACCESS_TTL_SECONDS))
      if (typeof tokens.refresh_token === 'string') {
        store.set(REFRESH_COOKIE, tokens.refresh_token, sessionCookieOptions(REFRESH_TTL_SECONDS))
      }
      return true
    })().finally(() => {
      inflightRefresh = null
    })
  }
  return inflightRefresh
}

async function clearSession(): Promise<void> {
  const store = await cookies()
  store.delete(ACCESS_COOKIE)
  store.delete(REFRESH_COOKIE)
  if (sessionExpiredHandler) await sessionExpiredHandler()
}

// Next 16's revalidateTag requires a cache-life profile alongside the tag. The tag
// is purged on every mutation regardless of profile; 'max' is the documented named
// profile applied to whatever repopulates the entry on the next server render.
const REVALIDATE_PROFILE = 'max'

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

async function authedFetch(
  method: Method,
  path: string,
  tags: string[],
  body?: unknown,
): Promise<Response> {
  const store = await cookies()
  const token = store.get(ACCESS_COOKIE)?.value
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`

  const init: RequestInit & { next?: { tags: string[] } } = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  // GETs participate in the Data Cache (tagged for revalidation); mutations never cache.
  if (method === 'GET') init.next = { tags }
  else init.cache = 'no-store'

  return fetch(`${baseUrl()}${path}`, init)
}

async function request<T>(method: Method, path: string, tags: string[], body?: unknown): Promise<T> {
  let res = await authedFetch(method, path, tags, body)

  if (res.status === 401) {
    const refreshed = await refreshSession()
    if (refreshed) res = await authedFetch(method, path, tags, body)
    if (res.status === 401) {
      await clearSession()
      throw await parseError(res)
    }
  }

  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T

  const text = await res.text()
  return (text ? (JSON.parse(text) as T) : (undefined as T))
}

export interface ServerApiClient {
  list<T>(entity: string): Promise<T[]>
  get<T>(entity: string, id: string): Promise<T>
  create<T>(entity: string, body: unknown): Promise<T>
  update<T>(entity: string, id: string, body: unknown): Promise<T>
  /** Soft delete by default (ADR-003) — archives the record server-side. */
  remove(entity: string, id: string): Promise<void>
}

class ServerApiClientImpl implements ServerApiClient {
  list<T>(entity: string): Promise<T[]> {
    return request<T[]>('GET', `/${entity}/`, [entity])
  }

  get<T>(entity: string, id: string): Promise<T> {
    return request<T>('GET', `/${entity}/${id}`, [entity])
  }

  async create<T>(entity: string, body: unknown): Promise<T> {
    const created = await request<T>('POST', `/${entity}/`, [entity], body)
    revalidateTag(entity, REVALIDATE_PROFILE)
    return created
  }

  async update<T>(entity: string, id: string, body: unknown): Promise<T> {
    const updated = await request<T>('PUT', `/${entity}/${id}`, [entity], body)
    revalidateTag(entity, REVALIDATE_PROFILE)
    return updated
  }

  async remove(entity: string, id: string): Promise<void> {
    await request<void>('DELETE', `/${entity}/${id}`, [entity])
    revalidateTag(entity, REVALIDATE_PROFILE)
  }
}

/** Construct a request-scoped client bound to the current session cookie. */
export function createServerApiClient(): ServerApiClient {
  return new ServerApiClientImpl()
}

export type { ApiError }
