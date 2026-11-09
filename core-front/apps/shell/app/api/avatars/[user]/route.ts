import { streamAvatar } from '@eerp/core-front/server'
import { errorResponse } from '@/lib/route-errors'

interface RouteContext {
  params: Promise<{ user: string }>
}

// GET /api/avatars/:user — stream a user's photo; Go's Cache-Control
// (private, max-age=300) passes through so the browser caches it briefly.
export async function GET(_request: Request, context: RouteContext) {
  const { user } = await context.params
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
