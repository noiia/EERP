import { NextResponse } from 'next/server'
import { goSiteFetch } from '@/website/account'

// POST /api/site-forms/:page/:block — a website Form block's submission (ADR-033).
// Forwards {values} to Go's POST /api/v1/website/forms/:page_id/:block_id, anonymous
// or with the VISITOR token (never the ERP one); Go's status and body (the error
// envelope, with `fields` on a 422) pass through.
export async function POST(request: Request, { params }: { params: Promise<{ page: string; block: string }> }) {
  const { page, block } = await params
  const body = await request.text()
  const path = `/website/forms/${encodeURIComponent(page)}/${encodeURIComponent(block)}`
  const res = await goSiteFetch(path, { method: 'POST', body }, 'optional').catch(() => null)
  if (!res) return NextResponse.json({ error: { code: 'UNAVAILABLE', message: '' } }, { status: 502 })
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status })
}
