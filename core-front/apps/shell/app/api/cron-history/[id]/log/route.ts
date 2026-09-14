import { NextResponse } from 'next/server'
import { ApiError, streamCronHistoryLog } from '@eerp/core-front/server'

// BFF proxy for one cron_history run's log file (docs/adr/ADR-016-cron-
// scheduler.md): stream its bytes. Go authorizes and tenant-pins; Next only
// forwards with the session Bearer — same shape as the /api/pictures/[id]
// route this mirrors.

function errorResponse(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, request_id: e.requestId } },
      { status: e.status },
    )
  }
  throw e
}

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET /api/cron-history/:id/log — stream the log file through without
// buffering. The response is a download (Content-Disposition: attachment,
// set by Go) rather than inline content like a picture, but the proxy shape
// is identical.
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params
  try {
    const upstream = await streamCronHistoryLog(id)
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8',
        'Content-Disposition': upstream.headers.get('content-disposition') ?? 'attachment',
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
