import { NextResponse } from 'next/server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// BFF for the distance widget: forwards to Go's GET /api/v1/geo/distance with
// the session Bearer; Go authorizes both references. Errors relay Go's status.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const qs = new URLSearchParams({ from: params.get('from') ?? '', to: params.get('to') ?? '' })
  try {
    return NextResponse.json(
      await apiRequest<{ meters: number | null }>('GET', `/geo/distance?${qs}`),
    )
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 502
    return NextResponse.json({ meters: null }, { status })
  }
}
