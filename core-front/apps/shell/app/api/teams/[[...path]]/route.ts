import { proxyTeams } from '@eerp/core-front/server'
import { errorResponse } from '@/lib/route-errors'

// BFF passthrough to Go's /api/v1/teams/*: one handler for every verb, relaying
// status, body (streamed, so downloads aren't buffered) and Content-Disposition.
// Go owns validation and the error envelope.

interface RouteContext {
  params: Promise<{ path?: string[] }>
}

async function forward(request: Request, context: RouteContext): Promise<Response> {
  const { path = [] } = await context.params
  if (path.some((s) => s === '.' || s === '..')) {
    return Response.json({ error: { code: 'BAD_REQUEST', message: 'Invalid path.' } }, { status: 400 })
  }
  const target = `${path.map((s) => `/${encodeURIComponent(s)}`).join('')}${new URL(request.url).search}`
  try {
    let body: unknown
    if (request.method === 'POST' || request.method === 'PUT') {
      const type = request.headers.get('content-type') ?? ''
      if (type.startsWith('multipart/form-data')) body = await request.formData()
      else if (type.includes('json')) body = await request.json()
    }
    const upstream = await proxyTeams(request.method as 'GET' | 'POST' | 'PUT' | 'DELETE', target, body)
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
export const PUT = forward
export const DELETE = forward
