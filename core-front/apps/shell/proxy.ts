import { NextResponse, type NextRequest } from 'next/server'
import {
  ACCESS_COOKIE,
  ACCESS_TTL_SECONDS,
  REFRESH_COOKIE,
  REFRESH_TTL_SECONDS,
  sessionCookieOptions,
} from '@eerp/core-front/server'
import { goAuthExchange } from '@/lib/bff'

// Proactively rotates the session ahead of every request, so by the time a Server
// Component renders, the access cookie is already fresh. This is the one place
// upstream of RSC render that both runs on every request and can legally write
// cookies (Next forbids `cookies().set()` during a Server Component render — see
// ApiClient.ts). It also restores "stay logged in for the refresh token's 7-day
// lifetime" — without it, the access cookie's 1h expiry silently drops a live
// session to anonymous until something reactively refreshes it.
//
// The access cookie's maxAge is set to match the access token's own TTL
// (ACCESS_TTL_SECONDS), so the browser dropping the cookie IS the "expired" signal —
// no JWT decoding needed here.

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth).*)'],
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const hasAccess = request.cookies.has(ACCESS_COOKIE)
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value
  if (hasAccess || !refreshToken) return NextResponse.next()

  try {
    const tokens = await goAuthExchange('refresh', { refresh_token: refreshToken })

    // Forward the refreshed access cookie into THIS request's headers too, so the
    // RSC render that follows sees it immediately instead of waiting a round trip.
    const forwardedRequest = new Headers(request.headers)
    const response = NextResponse.next({ request: { headers: forwardedRequest } })

    response.cookies.set(ACCESS_COOKIE, tokens.accessToken, sessionCookieOptions(ACCESS_TTL_SECONDS))
    if (tokens.refreshToken) {
      response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, sessionCookieOptions(REFRESH_TTL_SECONDS))
    }
    request.cookies.set(ACCESS_COOKIE, tokens.accessToken)
    return response
  } catch {
    // Spent/invalid refresh token (theft detection) or Go unreachable — clear the
    // session so the request renders anonymous instead of retrying every request.
    const response = NextResponse.next()
    response.cookies.delete(ACCESS_COOKIE)
    response.cookies.delete(REFRESH_COOKIE)
    return response
  }
}
