import { NextResponse } from 'next/server'
import { goSiteFetch } from '@/website/account'

// GET /api/site-booking/:id/calendar — a signed-in visitor's own booking as an
// .ics file (Go: GET /api/v1/website/me/bookings/:id/calendar.ics, 404 unless
// it's theirs). Through the BFF because the visitor token never reaches the browser.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await goSiteFetch(`/website/me/bookings/${encodeURIComponent(id)}/calendar.ics`).catch(() => null)
  if (!res) return new NextResponse(null, { status: 401 })
  if (!res.ok) return new NextResponse(null, { status: res.status })
  return new NextResponse(await res.arrayBuffer(), {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="booking.ics"' },
  })
}
