import { NextResponse } from 'next/server'
import { ApiError } from '@eerp/core-front/server'

/**
 * The BFF route handlers' shared error mapping: a Go error envelope (ApiError)
 * is passed through to the browser with its own status, code, message and
 * request id; anything else is rethrown, so Next reports it as a genuine 500
 * rather than dressing it up as an API error.
 */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, request_id: e.requestId } },
      { status: e.status },
    )
  }
  throw e
}
