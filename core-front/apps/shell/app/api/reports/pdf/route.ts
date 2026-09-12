import { ApiError, streamReportPDF } from '@eerp/core-front/server'
import { NextResponse } from 'next/server'

// BFF proxy for downloading a generated report — same shape as
// /api/pictures/:id: stream the bytes through without buffering.

function errorResponse(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, request_id: e.requestId } },
      { status: e.status },
    )
  }
  throw e
}

// GET /api/reports/pdf?key=...
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key') ?? ''
  try {
    const upstream = await streamReportPDF(key)
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/pdf',
        // Session-scoped binary content: keep it out of shared caches.
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
