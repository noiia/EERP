import 'server-only'
import { unstable_cache } from 'next/cache'
import { forwardedFor } from '@/lib/bff'
import type { Block, PublicDataSource } from './types'

function base(): string {
  const api = process.env.API_BASE
  if (!api) throw new Error('API_BASE is not set')
  return `${api}/api/v${process.env.API_VERSION ?? '1'}/public`
}

class PublicAPIError extends Error {
  constructor(readonly path: string, readonly status: number) {
    super(`public API ${path}: ${status}`)
  }
}

// Go rate-limits /public per client IP, so the visitor's IP is forwarded — but
// only through the closure: unstable_cache keys on [path] alone, so the 60 s
// cache stays shared across visitors (a fetch-level `next` cache would key on the
// header, i.e. per IP), and each miss is charged to the visitor who caused it.
// Every non-2xx but 404 throws inside the wrapper, so failures are never cached.
// Outside it, a 429 is transient: a block renders nothing (`transient: 'empty'`)
// instead of failing the whole page with a 500.
export async function getJSON<T>(path: string, tags: string[], transient: 'empty' | 'throw' = 'empty'): Promise<T | null> {
  const ip = await forwardedFor()
  try {
    return await unstable_cache(
      async (): Promise<T | null> => {
        const res = await fetch(base() + path, { headers: ip, cache: 'no-store' })
        if (res.status === 404) return null
        if (!res.ok) throw new PublicAPIError(path, res.status)
        return (await res.json()) as T
      },
      [path],
      { tags, revalidate: 60 },
    )()
  } catch (e) {
    if (e instanceof PublicAPIError && e.status === 429 && transient === 'empty') return null
    throw e
  }
}

type ListBody = { data: Record<string, unknown>[]; total: number }
const listPath = (table: string, params: URLSearchParams) => {
  const qs = params.toString()
  return `/${encodeURIComponent(table)}${qs ? '?' + qs : ''}`
}

export const serverPublicSource: PublicDataSource = {
  async list(table, q) {
    const params = new URLSearchParams()
    if (q.page_size) params.set('page_size', String(q.page_size))
    for (const [k, v] of Object.entries(q.filter ?? {})) params.set(`filter[${k}]`, v)
    const body = await getJSON<ListBody>(listPath(table, params), ['website_page', table])
    return body ? { records: body.data, total: body.total } : null
  },
  get: (table, id) => getJSON<Record<string, unknown>>(`/${encodeURIComponent(table)}/${encodeURIComponent(id)}`, ['website_page', table]),
}

export interface SitePage {
  id: string; slug: string; title: string; seo_description?: string | null; layout: Block[]
  /** Flag of the page's background picture anchor (website_page, id, background); absent if unpublished. */
  background?: boolean | null; background_parallax?: boolean | null
}

// Go serializes unset optional columns as JSON null.
const normalize = (p: SitePage): SitePage => ({ ...p, layout: p.layout ?? [] })

export async function getSitePage(slug: string): Promise<SitePage | null> {
  // filter[] skips empty values, so the home page ("") is matched with empty[slug].
  const params = new URLSearchParams({ page_size: '1' })
  params.set(slug === '' ? 'empty[slug]' : 'filter[slug]', slug === '' ? '1' : slug)
  // 'throw': a rate-limited page must not read as "no such page" (404, or the home
  // page's redirect to the ERP) — it fails and the visitor retries.
  const page = await getJSON<ListBody>(listPath('website_page', params), ['website_page'], 'throw')
  const rec = (page?.data as SitePage[] | undefined)?.find((r) => (r.slug ?? '') === slug)
  return rec ? normalize(rec) : null
}

export async function getMenuPages(): Promise<Pick<SitePage, 'slug' | 'title'>[]> {
  const res = await serverPublicSource.list('website_page', { filter: { in_menu: 'true' }, page_size: 50 })
  const seq = (p: SitePage & { menu_sequence?: number | null }) => p.menu_sequence ?? 0
  return ((res?.records ?? []) as unknown as (SitePage & { menu_sequence?: number | null })[])
    .sort((a, b) => seq(a) - seq(b))
    .map((p) => ({ slug: p.slug, title: p.title }))
}
