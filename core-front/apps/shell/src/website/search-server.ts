import 'server-only'
import { forwardedFor } from '@/lib/bff'
import { getJSON } from './public-api'
import { findSearchBlock, type PublicList } from './search'
import type { Block, SearchConfig } from './types'

// Server half shared by the autocomplete BFF route and the /search results page: the
// block's tables and columns always come from the stored, published page (Data Cache,
// tag website_page), never from the browser, which only sends its text.

/** The published page `pageId`'s search block `blockId`, or null. */
export async function loadSearchBlock(pageId: string, blockId: string): Promise<SearchConfig | null> {
  const page = await getJSON<{ layout: Block[] | null }>(`/website_page/${encodeURIComponent(pageId)}`, ['website_page']).catch(() => null)
  return findSearchBlock(page?.layout, blockId)
}

/** Go's public list API with the visitor's IP (Go rate-limits /public per IP), uncached
 * since the text varies. Any non-2xx reads as null. */
export async function publicSearchList(): Promise<PublicList> {
  const headers = await forwardedFor()
  const base = `${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/public`
  return async (path) => {
    const res = await fetch(base + path, { cache: 'no-store', headers }).catch(() => null)
    if (!res?.ok) return null
    const body = (await res.json().catch(() => null)) as { data?: Record<string, unknown>[] } | null
    return body?.data ?? null
  }
}
