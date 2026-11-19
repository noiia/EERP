import { NextResponse } from 'next/server'
import { runSearch } from '@/website/search'
import { loadSearchBlock, publicSearchList } from '@/website/search-server'

// GET /api/site-search/:page/:block?q= — a website Search block's autocomplete. The
// block's tables come from the stored, published page (search-server.ts), never from
// the browser; an unpublished page or block answers 404.
export async function GET(request: Request, { params }: { params: Promise<{ page: string; block: string }> }) {
  const { page, block } = await params
  const q = new URL(request.url).searchParams.get('q') ?? ''
  const config = await loadSearchBlock(page, block)
  if (!config) return NextResponse.json({ groups: [] }, { status: 404 })
  return NextResponse.json({ groups: await runSearch(config, q, await publicSearchList()) })
}
