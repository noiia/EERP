import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { goSiteFetch } from '@/website/account'

// POST /api/site-booking — the site's booking form (spec 4). Forwards to Go's
// POST /api/v1/website/bookings, anonymous or with the VISITOR token (never the
// ERP one); Go's status and body (the error envelope on failure) pass through.
export async function POST(request: Request) {
  const body = await request.text()
  const res = await goSiteFetch('/website/bookings', { method: 'POST', body }, 'optional').catch(() => null)
  if (!res) return NextResponse.json({ error: { code: 'UNAVAILABLE', message: '' } }, { status: 502 })
  if (res.ok) revalidateTag('event', { expire: 0 }) // seats-left counts are cached
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status })
}
