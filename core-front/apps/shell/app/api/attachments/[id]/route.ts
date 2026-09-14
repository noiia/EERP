import { NextResponse } from 'next/server'
import { ApiError, deleteAttachment, streamAttachment } from '@eerp/core-front/server'

// BFF proxy for one attachment: stream its bytes (triggering the browser's
// native download, via Go's Content-Disposition) and delete it — mirrors
// app/api/pictures/[id]/route.ts, with the one real difference being that
// Content-Disposition is forwarded (pictures never sets one; a picture is
// rendered inline as <img>, an attachment is meant to be saved by name).

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

// GET /api/attachments/:id — stream the file body through without buffering.
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params
  try {
    const upstream = await streamAttachment(id)
    const disposition = upstream.headers.get('content-disposition')
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        ...(disposition ? { 'Content-Disposition': disposition } : {}),
        // Session-scoped binary content: keep it out of shared caches.
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    return errorResponse(e)
  }
}

// DELETE /api/attachments/:id
export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params
  try {
    await deleteAttachment(id)
    return new Response(null, { status: 204 })
  } catch (e) {
    return errorResponse(e)
  }
}
