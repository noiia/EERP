import { NextResponse } from 'next/server'
import { ApiError, deletePicture, streamPicture } from '@eerp/core-front/server'

// BFF proxy for one picture: stream its bytes (the <img src> the widgets
// render) and delete it. Go authorizes and tenant-pins; Next only forwards
// with the session Bearer.

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

// GET /api/pictures/:id — stream the image body through without buffering.
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params
  try {
    const upstream = await streamPicture(id)
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        // Session-scoped binary content: keep it out of shared caches.
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    return errorResponse(e)
  }
}

// DELETE /api/pictures/:id
export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params
  try {
    await deletePicture(id)
    return new Response(null, { status: 204 })
  } catch (e) {
    return errorResponse(e)
  }
}
