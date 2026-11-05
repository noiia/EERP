import { NextResponse } from 'next/server'
import { forwardedFor } from '@/lib/bff'
import { getJSON } from '@/website/public-api'
import { findSearchBlock, runSearch, type PublicList } from '@/website/search'
import type { Block } from '@/website/types'

// GET /api/site-search/:page/:block?q= — a website Search block's results. The block's
// tables and columns come from the stored, published page (Data Cache, tag
// website_page), never from the browser, which only sends its text; each table is then
// searched through Go's public API with the visitor IP (Go rate-limits /public per IP),
// uncached since the text varies. An unpublished page or block answers 404.
export async function GET(request: Request, { params }: { params: Promise<{ page: string; block: string }> }) {
  const { page, block } = await params
  const q = new URL(request.url).searchParams.get('q') ?? ''
  const sitePage = await getJSON<{ layout: Block[] | null }>(`/website_page/${encodeURIComponent(page)}`, ['website_page']).catch(() => null)
  const config = findSearchBlock(sitePage?.layout, block)
  if (!config) return NextResponse.json({ groups: [] }, { status: 404 })
  const headers = await forwardedFor()
  const base = `${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/public`
  const list: PublicList = async (path) => {
    const res = await fetch(base + path, { cache: 'no-store', headers }).catch(() => null)
    if (!res?.ok) return null
    const body = (await res.json().catch(() => null)) as { data?: Record<string, unknown>[] } | null
    return body?.data ?? null
  }
  return NextResponse.json({ groups: await runSearch(config, q, list) })
}
