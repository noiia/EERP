import 'server-only'
import type { Block, PublicDataSource } from './types'

function base(): string {
  const api = process.env.API_BASE
  if (!api) throw new Error('API_BASE is not set')
  return `${api}/api/v${process.env.API_VERSION ?? '1'}/public`
}

async function getJSON<T>(path: string, tags: string[]): Promise<T | null> {
  const res = await fetch(base() + path, { next: { tags, revalidate: 60 } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`public API ${path}: ${res.status}`)
  return (await res.json()) as T
}

export const serverPublicSource: PublicDataSource = {
  async list(table, q) {
    const params = new URLSearchParams()
    if (q.page_size) params.set('page_size', String(q.page_size))
    for (const [k, v] of Object.entries(q.filter ?? {})) params.set(`filter[${k}]`, v)
    const qs = params.toString()
    const body = await getJSON<{ data: Record<string, unknown>[]; total: number }>(
      `/${table}${qs ? '?' + qs : ''}`, ['website_page', table])
    return body ? { records: body.data, total: body.total } : null
  },
  get: (table, id) => getJSON<Record<string, unknown>>(`/${table}/${encodeURIComponent(id)}`, ['website_page', table]),
}

/** Browser-relative: the gateway routes /api/v1/* to Go, and public pictures need no session. */
export function pictureUrl(table: string, record: string, field: string): string {
  return `/api/v1/public/${table}/${record}/picture/${field}`
}

export interface SitePage { id: string; slug: string; title: string; seo_description?: string | null; layout: Block[] }

// Go serializes unset optional columns as JSON null.
const normalize = (p: SitePage): SitePage => ({ ...p, layout: p.layout ?? [] })

export async function getSitePage(slug: string): Promise<SitePage | null> {
  // The list filter skips empty values, so the home page ("") is picked client-side.
  const page = slug === ''
    ? await serverPublicSource.list('website_page', { page_size: 50 })
    : await serverPublicSource.list('website_page', { filter: { slug }, page_size: 1 })
  const rec = (page?.records as SitePage[] | undefined)?.find((r) => r.slug === slug)
  return rec ? normalize(rec) : null
}

export async function getMenuPages(): Promise<Pick<SitePage, 'slug' | 'title'>[]> {
  const res = await serverPublicSource.list('website_page', { filter: { in_menu: 'true' }, page_size: 50 })
  const seq = (p: SitePage & { menu_sequence?: number | null }) => p.menu_sequence ?? 0
  return ((res?.records ?? []) as unknown as (SitePage & { menu_sequence?: number | null })[])
    .sort((a, b) => seq(a) - seq(b))
    .map((p) => ({ slug: p.slug, title: p.title }))
}
