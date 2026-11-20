import { officeSession } from '@eerp/core-front/server'
import { errorResponse } from '@/lib/route-errors'

export async function GET(
  request: Request,
  context: { params: Promise<{ source: string; id: string }> },
) {
  const { source, id } = await context.params
  if (
    !['team-file', 'team-attachment', 'attachment'].includes(source) ||
    !/^[a-f0-9-]{36}$/i.test(id)
  ) {
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'No such document.' } },
      { status: 404 },
    )
  }
  try {
    const res = await officeSession(
      source,
      id,
      new URL(request.url).searchParams.get('lang') ?? 'en',
    )
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
