'use server'
import { revalidateTag } from 'next/cache'
import { headers } from 'next/headers'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings -> Website: published data, routing and website
// accounts (dedicated Go endpoints, not the generic CRUD surface). Mutations
// return a result object — Next masks errors thrown inside Server Actions.

/** `message` is Go's message, or '' for an unexpected failure: the form shows
 * its own translated fallback (Server Actions have no user locale). */
export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : '' }
}

async function save(method: 'PUT', path: string, body: unknown, extra?: Record<string, string>): Promise<SaveResult> {
  try {
    await (extra ? apiRequest(method, path, body, extra) : apiRequest(method, path, body))
    return { ok: true }
  } catch (e) {
    return failure(e)
  }
}

export interface PublishedTable {
  table: string
  declared: string[]
  fields: string[]
  /** Declared fields able to hold a picture (anchor fields, boolean picture flags). */
  pictures?: string[]
  filter: Record<string, string>
}
export interface PublishedSelection {
  fields: string[]
  filter: Record<string, string>
}

export async function getPublished(): Promise<PublishedTable[]> {
  try {
    return (await apiRequest<PublishedTable[] | null>('GET', '/settings/website/public')) ?? []
  } catch {
    return []
  }
}

export async function savePublished(table: string, sel: PublishedSelection): Promise<SaveResult> {
  const res = await save('PUT', `/settings/website/public/${encodeURIComponent(table)}`, sel)
  if (res.ok) {
    // Expire the site's cached public reads now (public-api.ts tags them with the
    // table and 'website_page'), so an unpublish is never served stale. Public
    // pictures keep their own 300 s HTTP max-age.
    revalidateTag(table, { expire: 0 })
    revalidateTag('website_page', { expire: 0 })
  }
  return res
}

export interface Routing {
  mode: 'path' | 'host'
  site_host: string
  erp_host: string
}

export async function getRouting(): Promise<Routing> {
  try {
    return await apiRequest<Routing>('GET', '/settings/website/routing')
  } catch {
    return { mode: 'path', site_host: '', erp_host: '' }
  }
}

/** Go's lockout guard needs the Host the browser is actually on. */
export async function saveRouting(r: Routing): Promise<SaveResult> {
  const host = (await headers()).get('host') ?? ''
  return save('PUT', '/settings/website/routing', r, { 'X-EERP-Request-Host': host })
}

export interface WebsiteUser {
  id: string
  email: string
  name: string
  surname: string
  phone: string
  created_at: string
  disabled: boolean
  email_verified: boolean
}

export async function listWebsiteUsers(): Promise<WebsiteUser[]> {
  try {
    return (await apiRequest<WebsiteUser[] | null>('GET', '/website_admin/users')) ?? []
  } catch {
    return []
  }
}

// 'use server' exports must be async function declarations (Next rejects arrow consts at build).
export async function updateWebsiteUser(
  id: string,
  patch: Partial<Pick<WebsiteUser, 'disabled' | 'name' | 'surname' | 'phone'>>,
): Promise<SaveResult> {
  return save('PUT', `/website_admin/users/${encodeURIComponent(id)}`, patch)
}

export type OutboxStatus = 'pending' | 'sent' | 'failed'

export interface OutboxMail {
  id: string
  to_address: string
  subject: string
  status: OutboxStatus
  attempts: number
  next_attempt_at: string
  last_error: string
  sent_at: string | null
  created_at: string
}

/** Newest 200 outbox rows, optionally one status only (Go caps page_size at 200). */
export async function listOutbox(status?: OutboxStatus): Promise<OutboxMail[]> {
  const q = new URLSearchParams({ page_size: '200' })
  if (status) q.set('status', status)
  try {
    return (await apiRequest<{ data: OutboxMail[] }>('GET', `/mail_outbox?${q}`)).data ?? []
  } catch {
    return []
  }
}

/** A failed row back to pending with a fresh attempt budget. */
export async function retryOutbox(id: string): Promise<SaveResult> {
  try {
    await apiRequest('POST', `/mail_outbox/${encodeURIComponent(id)}/retry`)
    return { ok: true }
  } catch (e) {
    return failure(e)
  }
}
