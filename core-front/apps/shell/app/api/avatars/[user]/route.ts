import { streamAvatar } from '@eerp/core-front/server'
import { errorResponse } from '@/lib/route-errors'

interface RouteContext {
  params: Promise<{ user: string }>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/avatars/:user — stream a user's photo; Go's Cache-Control
// (private, max-age=300) passes through so the browser caches it briefly.
export async function GET(_request: Request, context: RouteContext) {
  const { user } = await context.params
  // A dot-segment or path must never retarget the Go request.
  if (!UUID.test(user)) return new Response(null, { status: 404 })
  try {
    const upstream = await streamAvatar(user)
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'Cache-Control': upstream.headers.get('cache-control') ?? 'private, no-store',
      },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
