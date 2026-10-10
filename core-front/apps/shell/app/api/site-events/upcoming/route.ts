import { NextResponse } from 'next/server'
import { forwardedFor } from '@/lib/bff'

// GET /api/site-events/upcoming?limit=&near= — the event list's "nearest to me"
// re-fetch, from the visitor's browser. Relays Go's public endpoint with the
// visitor IP (Go rate-limits /public per IP); never cached (positions vary).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const qs = new URLSearchParams()
  const limit = params.get('limit')
  const near = params.get('near')
  if (limit) qs.set('limit', limit)
  if (near) qs.set('near', near)
  const res = await fetch(`${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/public/events/upcoming?${qs}`, {
    cache: 'no-store',
    headers: await forwardedFor(),
  }).catch(() => null)
  if (!res) return NextResponse.json({ data: [] }, { status: 502 })
  return NextResponse.json(await res.json().catch(() => ({ data: [] })), { status: res.status })
}
