import { proxyExchange } from '@eerp/core-front/server'
import { errorResponse } from '@/lib/route-errors'

// BFF passthrough to Go's project plan exchange routes (ADR-042):
// /api/exchange/<scopeEntity>/<id>/<format>/<action> →
// /api/v1/<scopeEntity>/<id>/exchange/<format>/<action>.
//
// Like the teams route: one handler per verb, relaying status, body (streamed, so
// the export download isn't buffered) and Content-Disposition; Go owns validation
// and the error envelope. What this route adds is the shape contract — the URL is
// built from a descriptor's own `scopeEntity` and format keys, so anything that
// isn't exactly those four segments, or names an action Go has no handler for, is
// refused here rather than forwarded as a request Go would have to 404.

/** The three wizard calls, and the only actions Go mounts. */
const ACTIONS = new Set(['export', 'preview', 'apply'])

interface RouteContext {
  params: Promise<{ path?: string[] }>
}

async function forward(request: Request, context: RouteContext): Promise<Response> {
  const { path = [] } = await context.params
  if (path.length !== 4 || path.some((s) => s === '.' || s === '..') || !ACTIONS.has(path[3])) {
    return Response.json({ error: { code: 'BAD_REQUEST', message: 'Invalid path.' } }, { status: 400 })
  }
  const [scopeEntity, id, format, action] = path
  const target = `/${encodeURIComponent(scopeEntity)}/${encodeURIComponent(id)}/exchange/${encodeURIComponent(format)}/${action}${new URL(request.url).search}`
  try {
    // preview and apply are multipart uploads (the file, plus the base and the
    // ticked keys); export is a plain GET. The body goes through as FormData, so
    // fetch re-mints the boundary — the inbound content-type header must not.
    const body =
      request.method === 'POST' && (request.headers.get('content-type') ?? '').startsWith('multipart/form-data')
        ? await request.formData()
        : undefined
    const upstream = await proxyExchange(request.method as 'GET' | 'POST', target, body)
    const disposition = upstream.headers.get('content-disposition')
    return new Response(upstream.status === 204 ? null : upstream.body, {
      status: upstream.status,
      headers: {
        ...(upstream.headers.get('content-type') ? { 'Content-Type': upstream.headers.get('content-type')! } : {}),
        ...(disposition ? { 'Content-Disposition': disposition } : {}),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    return errorResponse(e)
  }
}

export const GET = forward
export const POST = forward
