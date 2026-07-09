import 'server-only'
import { cookies } from 'next/headers'
import { revalidateTag } from 'next/cache'
import { parseError } from './errors'
import type { EntityListOptions } from './list-options'
import type { PictureAnchor, PictureMeta } from './pictures-client'
import type { ViewFieldsConfig } from './view-fields'

export type { EntityListOptions } from './list-options'
export type { ViewFieldsConfig } from './view-fields'
import {
  ACCESS_COOKIE,
  ACCESS_TTL_SECONDS,
  GO_REFRESH_COOKIE,
  REFRESH_COOKIE,
  REFRESH_TTL_SECONDS,
  parseSetCookie,
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
      const accessToken = (data as { access_token?: unknown } | null)?.access_token
      if (typeof accessToken !== 'string') return false

      store.set(ACCESS_COOKIE, accessToken, sessionCookieOptions(ACCESS_TTL_SECONDS))
      // Go rotates the refresh token via a Set-Cookie header, not the JSON body.
      const rotated = parseSetCookie(res.headers, GO_REFRESH_COOKIE)
      if (rotated) {
        store.set(REFRESH_COOKIE, rotated, sessionCookieOptions(REFRESH_TTL_SECONDS))
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

// tags: the Data Cache tags for a GET, or null to force no-store — per-user and
// per-tenant responses must never land in the shared cache.
async function authedFetch(
  method: Method,
  path: string,
  tags: string[] | null,
  body?: unknown,
): Promise<Response> {
  const store = await cookies()
  const token = store.get(ACCESS_COOKIE)?.value
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`

  const init: RequestInit & { next?: { tags: string[] } } = { method, headers }
  // Tag check instead of instanceof: the FormData parsed from an incoming Request
  // (undici) and the ambient global are different constructors under test runners.
  if (Object.prototype.toString.call(body) === '[object FormData]') {
    // Multipart passthrough (picture uploads): fetch derives the boundary-carrying
    // Content-Type itself — setting one manually would corrupt the body.
    init.body = body as FormData
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  // Tagged GETs participate in the Data Cache (revalidated by mutations); everything
  // else — mutations and untagged session-scoped reads — never caches.
  if (method === 'GET' && tags) init.next = { tags }
  else init.cache = 'no-store'

  return fetch(`${baseUrl()}${path}`, init)
}

// The session-semantics core shared by every Go call: Bearer from the cookie,
// refresh-once on 401, clear-and-throw when the refresh doesn't stick. Returns
// the (possibly non-OK) response so callers decide how to read the body — JSON
// (request) or a raw stream (streamPicture).
async function fetchWithRefresh(
  method: Method,
  path: string,
  tags: string[] | null,
  body?: unknown,
): Promise<Response> {
  let res = await authedFetch(method, path, tags, body)

  if (res.status === 401) {
    const refreshed = await refreshSession()
    if (refreshed) res = await authedFetch(method, path, tags, body)
    if (res.status === 401) {
      await clearSession()
      throw await parseError(res)
    }
  }
  return res
}

async function request<T>(method: Method, path: string, tags: string[] | null, body?: unknown): Promise<T> {
  const res = await fetchWithRefresh(method, path, tags, body)

  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T

  const text = await res.text()
  return (text ? (JSON.parse(text) as T) : (undefined as T))
}

function listQuery(options?: EntityListOptions): string {
  if (!options) return ''
  const params = new URLSearchParams()
  for (const [col, value] of Object.entries(options.filter ?? {})) {
    params.set(`filter[${col}]`, value)
  }
  for (const [col, value] of Object.entries(options.search ?? {})) {
    params.set(`search[${col}]`, value)
  }
  if (options.page) params.set('page', String(options.page))
  if (options.pageSize) params.set('page_size', String(options.pageSize))
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export interface ServerApiClient {
  list<T>(entity: string, options?: EntityListOptions): Promise<T[]>
  get<T>(entity: string, id: string): Promise<T>
  create<T>(entity: string, body: unknown): Promise<T>
  update<T>(entity: string, id: string, body: unknown): Promise<T>
  /** Soft delete by default (ADR-003) — archives the record server-side. */
  remove(entity: string, id: string): Promise<void>
  /**
   * entity's Kanban status field / Calendar date field, as configured from
   * Settings -> Views (docs/roadmaps/list-view-modes.md, ADR-006). Never
   * cached (tenant-wide settings, like preferences) — always a fresh read.
   */
  getViewFields(entity: string): Promise<ViewFieldsConfig>
  /**
   * Like list(), but also returns Go's `total` row count — the tree view's
   * loader uses this (not list()) so Graph mode's aggregate widgets (Phase 5,
   * docs/roadmaps/list-view-modes.md) can tell a full fetch from a
   * page_size-truncated one, without a second request.
   */
  listWithTotal<T>(entity: string, options?: EntityListOptions): Promise<{ records: T[]; total: number }>
}

class ServerApiClientImpl implements ServerApiClient {
  // Go's ORM server mounts list/create at `/{entity}` (no trailing slash) and the
  // rest at `/{entity}/{id}`. List returns a paginated envelope { data, total, ... };
  // single-record endpoints return the record object directly.
  async list<T>(entity: string, options?: EntityListOptions): Promise<T[]> {
    const { records } = await this.listWithTotal<T>(entity, options)
    return records
  }

  async listWithTotal<T>(
    entity: string,
    options?: EntityListOptions,
  ): Promise<{ records: T[]; total: number }> {
    // Filtered variants cache under their own URL key but share the entity tag,
    // so every mutation of the entity revalidates them too.
    const body = await request<unknown>('GET', `/${entity}${listQuery(options)}`, [entity])
    if (Array.isArray(body)) return { records: body as T[], total: body.length }
    const envelope = body as { data?: unknown; total?: unknown } | null
    const data = envelope?.data
    const records = Array.isArray(data) ? (data as T[]) : []
    // A bare-array response (no envelope) has no `total` — records.length is
    // the only honest answer, same as the paginated envelope's own total
    // being exactly what Go counted server-side.
    const total = typeof envelope?.total === 'number' ? envelope.total : records.length
    return { records, total }
  }

  get<T>(entity: string, id: string): Promise<T> {
    return request<T>('GET', `/${entity}/${id}`, [entity])
  }

  async create<T>(entity: string, body: unknown): Promise<T> {
    const created = await request<T>('POST', `/${entity}`, [entity], body)
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

  async getViewFields(entity: string): Promise<ViewFieldsConfig> {
    const raw = await request<{ kanban_status_field: string | null; calendar_date_field: string | null }>(
      'GET',
      `/settings/views/${entity}/fields`,
      null,
    )
    return {
      kanbanStatusField: raw.kanban_status_field ?? null,
      calendarDateField: raw.calendar_date_field ?? null,
    }
  }
}

/** Construct a request-scoped client bound to the current session cookie. */
export function createServerApiClient(): ServerApiClient {
  return new ServerApiClientImpl()
}

/**
 * Authed request to a non-entity backend endpoint (self-service preferences, tenant
 * settings — anything with a dedicated handler instead of the generic CRUD surface).
 * Shares the entity client's session semantics (Bearer from the cookie, refresh-once
 * on 401, ApiError on failure) but always bypasses the Data Cache: these responses
 * are per-user or per-tenant, so a shared cache entry would leak state across
 * sessions. `path` is relative to the versioned API base (e.g. "/me/preferences").
 */
export function apiRequest<T>(method: Method, path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, null, body)
}

// ── Picture service (Go side of the BFF proxy) ───────────────────────────────
// The /api/pictures BFF route handlers call these; the browser-facing half
// (what widgets use) is src/api/pictures-client.ts on the client barrel.
// Binary, per-tenant content — never cached, so every call bypasses the Data
// Cache the way apiRequest does.

/**
 * Forward a multipart upload to Go. `form` carries table_name / record_id /
 * field plus the `file` part — the BFF route passes the browser's FormData
 * through untouched.
 */
export async function uploadPicture(form: FormData): Promise<PictureMeta> {
  const res = await fetchWithRefresh('POST', '/pictures', null, form)
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as PictureMeta
}

/** Resolve an anchor to its picture metadata; null when the field has none. */
export async function findPicture(anchor: PictureAnchor): Promise<PictureMeta | null> {
  const query = new URLSearchParams({
    table: anchor.table,
    record: anchor.recordId,
    field: anchor.field,
  })
  const res = await fetchWithRefresh('GET', `/pictures?${query}`, null)
  if (res.status === 404) return null
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as PictureMeta
}

/**
 * Fetch a picture's bytes from Go. Returns the raw Response so the BFF route
 * can stream body + content type back to the browser without buffering.
 */
export async function streamPicture(id: string): Promise<Response> {
  const res = await fetchWithRefresh('GET', `/pictures/${id}`, null)
  if (!res.ok) throw await parseError(res)
  return res
}

export async function deletePicture(id: string): Promise<void> {
  const res = await fetchWithRefresh('DELETE', `/pictures/${id}`, null)
  if (!res.ok) throw await parseError(res)
}
