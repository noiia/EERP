'use server'
import { headers } from 'next/headers'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings -> Website: published data, routing and website
// accounts (dedicated Go endpoints, not the generic CRUD surface). Mutations
// return a result object — Next masks errors thrown inside Server Actions.

export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown, fallback: string): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : fallback }
}

async function save(method: 'PUT', path: string, body: unknown, extra?: Record<string, string>): Promise<SaveResult> {
  try {
    await (extra ? apiRequest(method, path, body, extra) : apiRequest(method, path, body))
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not save.')
  }
}

export interface PublishedTable {
  table: string
  declared: string[]
  fields: string[]
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

export const savePublished = (table: string, sel: PublishedSelection) =>
  save('PUT', `/settings/website/public/${encodeURIComponent(table)}`, sel)

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

export const updateWebsiteUser = (
  id: string,
  patch: Partial<Pick<WebsiteUser, 'disabled' | 'name' | 'surname' | 'phone'>>,
) => save('PUT', `/website_admin/users/${encodeURIComponent(id)}`, patch)
