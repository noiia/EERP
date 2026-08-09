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
//
// That reactive refresh can only run from a Route Handler/Server Action — Next
// forbids writing cookies during a Server Component render, and `proxy.ts`
// (apps/shell — Next's "middleware" file convention, renamed) is the one place that
// runs ahead of every RSC render and CAN write cookies, so it proactively rotates the
// session before render whenever the access cookie is missing. A 401 that still
// reaches here from an RSC read (e.g. Go revoked the token mid-window) fails closed
// instead of refreshing: spending Go's single-use refresh token without being able to
// persist the rotated cookie would silently brick the next real refresh attempt,
// which is worse than surfacing this one 401.

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

// True once cookies() confirms we're in a Route Handler/Server Action/middleware
// (writes allowed) rather than a Server Component render (writes forbidden). Probed
// via a throwaway delete rather than checked structurally — Next exposes no public
// API for "can I write cookies right now," only the thrown error on an actual attempt.
async function canWriteCookies(store: Awaited<ReturnType<typeof cookies>>): Promise<boolean> {
  try {
    store.delete('__eerp_cookie_probe')
    return true
  } catch (err) {
    if (err instanceof Error && err.message.includes('Cookies can only be modified')) return false
    throw err
  }
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
// per-tenant responses must never land in the shared cache. tokenOverride bypasses
// the session cookie entirely (see fetchWithRefresh's own doc comment on why).
async function authedFetch(
  method: Method,
  path: string,
  tags: string[] | null,
  body?: unknown,
  tokenOverride?: string,
): Promise<Response> {
  const token = tokenOverride ?? (await cookies()).get(ACCESS_COOKIE)?.value
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
  tokenOverride?: string,
): Promise<Response> {
  let res = await authedFetch(method, path, tags, body, tokenOverride)

  if (res.status === 401) {
    if (tokenOverride) {
      // A caller-supplied token (e.g. the PDF print route's short-lived,
      // query-param token — docs/adr/ADR-010) has no session cookie behind
      // it and no refresh token to rotate. A 401 here means the token is
      // simply invalid/expired — fail closed instead of touching any of the
      // cookie-refresh machinery below, which doesn't apply to it.
      throw await parseError(res)
    }
    if (!(await canWriteCookies(await cookies()))) {
      // RSC render: middleware already had its one legal chance to refresh ahead of
      // this request. Refreshing again here could spend Go's single-use refresh
      // token with no way to persist the rotation — fail closed instead of crashing
      // or silently bricking the next real refresh.
      throw await parseError(res)
    }
    const refreshed = await refreshSession()
    if (refreshed) res = await authedFetch(method, path, tags, body)
    if (res.status === 401) {
      await clearSession()
      throw await parseError(res)
    }
  }
  return res
}

async function request<T>(
  method: Method,
  path: string,
  tags: string[] | null,
  body?: unknown,
  tokenOverride?: string,
): Promise<T> {
  const res = await fetchWithRefresh(method, path, tags, body, tokenOverride)

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
   * A boolean/picture widget's configured box size, either the workspace-wide
   * Base default (module: 'base') or one specific app's own override
   * (Settings -> Apps) — `null` when unset at that level. Never cached, same
   * posture as getViewFields.
   */
  getPictureSize(module: string): Promise<{ width: number; height: number } | null>
  /**
   * The workspace-wide PDF report letterhead (Settings -> Global settings ->
   * Reports) — footer/address text stamped on every generated report unless
   * a report_page_format row overrides it (report-chrome.ts). Never cached,
   * same posture as getViewFields/getPictureSize; empty strings when unset.
   */
  getReportsLayout(): Promise<{ footer: string; address: string }>
  /**
   * The caller's active company (multi-company) — its id/name only (the
   * `/me/preferences` response shape), never null once ResolveActive has
   * bootstrapped one server-side; only absent if this read itself failed.
   * Never cached, same posture as getReportsLayout.
   */
  getMyActiveCompany(): Promise<{ id: string; name: string } | null>
  /**
   * Like list(), but also returns Go's `total` row count — the tree view's
   * loader uses this (not list()) so Graph mode's aggregate widgets (Phase 5,
   * docs/roadmaps/list-view-modes.md) can tell a full fetch from a
   * page_size-truncated one, without a second request.
   */
  listWithTotal<T>(entity: string, options?: EntityListOptions): Promise<{ records: T[]; total: number }>
}

class ServerApiClientImpl implements ServerApiClient {
  // tokenOverride, when set, is used for EVERY call this instance makes instead
  // of the session cookie — see createServerApiClient's doc comment.
  constructor(private readonly tokenOverride?: string) {}

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
    const body = await request<unknown>(
      'GET',
      `/${entity}${listQuery(options)}`,
      [entity],
      undefined,
      this.tokenOverride,
    )
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
    return request<T>('GET', `/${entity}/${id}`, [entity], undefined, this.tokenOverride)
  }

  async create<T>(entity: string, body: unknown): Promise<T> {
    const created = await request<T>('POST', `/${entity}`, [entity], body, this.tokenOverride)
    revalidateTag(entity, REVALIDATE_PROFILE)
    return created
  }

  async update<T>(entity: string, id: string, body: unknown): Promise<T> {
    const updated = await request<T>('PUT', `/${entity}/${id}`, [entity], body, this.tokenOverride)
    revalidateTag(entity, REVALIDATE_PROFILE)
    return updated
  }

  async remove(entity: string, id: string): Promise<void> {
    await request<void>('DELETE', `/${entity}/${id}`, [entity], undefined, this.tokenOverride)
    revalidateTag(entity, REVALIDATE_PROFILE)
  }

  async getViewFields(entity: string): Promise<ViewFieldsConfig> {
    const raw = await request<{ kanban_status_field: string | null; calendar_date_field: string | null }>(
      'GET',
      `/settings/views/${entity}/fields`,
      null,
      undefined,
      this.tokenOverride,
    )
    return {
      kanbanStatusField: raw.kanban_status_field ?? null,
      calendarDateField: raw.calendar_date_field ?? null,
    }
  }

  async getPictureSize(module: string): Promise<{ width: number; height: number } | null> {
    const raw = await request<{ size: { width: number; height: number } | null }>(
      'GET',
      `/settings/apps/${module}/picture-size`,
      null,
      undefined,
      this.tokenOverride,
    )
    return raw.size ?? null
  }

  getReportsLayout(): Promise<{ footer: string; address: string }> {
    return request<{ footer: string; address: string }>(
      'GET',
      '/settings/reports/layout',
      null,
      undefined,
      this.tokenOverride,
    )
  }

  async getMyActiveCompany(): Promise<{ id: string; name: string } | null> {
    const raw = await request<{ active_company: { id: string; name: string } | null }>(
      'GET',
      '/me/preferences',
      null,
      undefined,
      this.tokenOverride,
    )
    return raw.active_company ?? null
  }
}

/** Construct a request-scoped client bound to the current session cookie. */
/**
 * Construct a request-scoped client. With no argument it's bound to the
 * current session cookie (every existing call site). Pass an explicit
 * `tokenOverride` for a request that has no session cookie at all — the ONE
 * current caller is the PDF print route (docs/adr/ADR-010), reading a
 * short-lived token Go minted into the URL's `?token=` query param, since a
 * Server Component render cannot write cookies and pdf-service's headless
 * Chrome carries no browser session to begin with. An overridden client
 * never refreshes on 401 (see fetchWithRefresh) — there is no refresh token
 * behind a scoped token, so a 401 just fails.
 */
export function createServerApiClient(tokenOverride?: string): ServerApiClient {
  return new ServerApiClientImpl(tokenOverride)
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

/**
 * Resolve an anchor to its picture metadata; null when the field has none.
 * `tokenOverride` lets the PDF print route (no session cookie, see
 * `createServerApiClient`'s doc comment) resolve pictures the same way it
 * resolves the record itself — every other caller (the BFF route handlers)
 * omits it and rides the normal session-cookie/refresh path.
 */
export async function findPicture(anchor: PictureAnchor, tokenOverride?: string): Promise<PictureMeta | null> {
  const query = new URLSearchParams({
    table: anchor.table,
    record: anchor.recordId,
    field: anchor.field,
  })
  const res = await fetchWithRefresh('GET', `/pictures?${query}`, null, undefined, tokenOverride)
  if (res.status === 404) return null
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as PictureMeta
}

/**
 * Fetch a picture's bytes from Go. Returns the raw Response so the BFF route
 * can stream body + content type back to the browser without buffering.
 * `tokenOverride`: see findPicture.
 */
export async function streamPicture(id: string, tokenOverride?: string): Promise<Response> {
  const res = await fetchWithRefresh('GET', `/pictures/${id}`, null, undefined, tokenOverride)
  if (!res.ok) throw await parseError(res)
  return res
}

/**
 * Resolve a picture anchor straight to a `data:` URL, or null when the field
 * has no picture — the print route's own need (docs/adr/ADR-011): a
 * ReportImageNode's value must be usable as an `<img src>` by the time
 * pdf-service's headless Chrome navigates to the print page, which carries
 * no session of its own to fetch a `/pictures/:id` URL live. Inlining the
 * bytes at render time sidesteps that entirely — no extra auth plumbing for
 * Chrome, no separate network round trip during the print.
 */
export async function resolvePictureDataURL(anchor: PictureAnchor, tokenOverride?: string): Promise<string | null> {
  const meta = await findPicture(anchor, tokenOverride)
  if (!meta) return null
  const res = await streamPicture(meta.id, tokenOverride)
  const bytes = Buffer.from(await res.arrayBuffer())
  return `data:${meta.mime};base64,${bytes.toString('base64')}`
}

export async function deletePicture(id: string): Promise<void> {
  const res = await fetchWithRefresh('DELETE', `/pictures/${id}`, null)
  if (!res.ok) throw await parseError(res)
}

// ── PDF reports (Go side of the BFF proxy) ───────────────────────────────────
// The /api/reports BFF route handlers call these (docs/adr/ADR-010,
// docs/roadmaps/pdf-reports.md Phase 4) — the same session-cookie path every
// other write in this file uses; NOT the tokenOverride path, which is the
// PRINT ROUTE's own separate, unauthenticated-by-cookie call back to Go.

/**
 * Trigger report generation. Go's response carries ITS OWN download_url (a
 * Go API path, `/api/v1/reports/pdf?key=...`) — translated here to this
 * BFF's own proxy path so the browser is handed something it can actually
 * reach without an Authorization header of its own.
 */
export async function generateReportPDF(name: string, recordId: string): Promise<{ downloadURL: string }> {
  const res = await fetchWithRefresh(
    'POST',
    `/reports/${encodeURIComponent(name)}/${encodeURIComponent(recordId)}/pdf`,
    null,
  )
  if (!res.ok) throw await parseError(res)
  const body = (await res.json()) as { download_url: string }
  const key = new URL(body.download_url, 'http://internal').searchParams.get('key') ?? ''
  return { downloadURL: `/api/reports/pdf?key=${encodeURIComponent(key)}` }
}

/**
 * Fetch a generated report's bytes from Go. Returns the raw Response so the
 * BFF route can stream body + content type back to the browser without
 * buffering — same shape as streamPicture.
 */
export async function streamReportPDF(key: string): Promise<Response> {
  const res = await fetchWithRefresh('GET', `/reports/pdf?key=${encodeURIComponent(key)}`, null)
  if (!res.ok) throw await parseError(res)
  return res
}
