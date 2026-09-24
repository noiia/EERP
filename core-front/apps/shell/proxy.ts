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

// Per-request CSP nonce (https://nextjs.org/docs/app/guides/content-security-policy):
// App Router streams hydration/RSC payloads via inline `<script>` tags it injects
// itself, which a strict `script-src 'self'` blocks outright — the resulting broken
// hydration is what makes a controlled MUI field's label (acting as the placeholder)
// never shrink on input, among other silent failures. Next only nonces its own
// inline scripts when it sees the nonce on the REQUEST headers flowing into the
// render, so this must happen in middleware, not in nginx after the fact — nginx
// can't know a nonce it never generated. This header is now the sole source of CSP
// for the frontend; infra/nginx/nginx.conf's own Content-Security-Policy add_header
// was removed so the two don't combine into a stricter, nonce-less intersection.
function cspHeaderValue(nonce: string): string {
  return `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
}

function withCsp(response: NextResponse, nonce: string): NextResponse {
  response.headers.set('Content-Security-Policy', cspHeaderValue(nonce))
  return response
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = btoa(crypto.randomUUID())
  const forwardedRequest = new Headers(request.headers)
  forwardedRequest.set('x-nonce', nonce)
  forwardedRequest.set('Content-Security-Policy', cspHeaderValue(nonce))

  const hasAccess = request.cookies.has(ACCESS_COOKIE)
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value
  if (hasAccess || !refreshToken) {
    return withCsp(NextResponse.next({ request: { headers: forwardedRequest } }), nonce)
  }

  try {
    const tokens = await goAuthExchange('refresh', { refresh_token: refreshToken })

    // Forward the refreshed access cookie into THIS request's headers too, so the
    // RSC render that follows sees it immediately instead of waiting a round trip.
    const response = NextResponse.next({ request: { headers: forwardedRequest } })

    response.cookies.set(ACCESS_COOKIE, tokens.accessToken, sessionCookieOptions(ACCESS_TTL_SECONDS))
    if (tokens.refreshToken) {
      response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, sessionCookieOptions(REFRESH_TTL_SECONDS))
    }
    request.cookies.set(ACCESS_COOKIE, tokens.accessToken)
    return withCsp(response, nonce)
  } catch {
    // Spent/invalid refresh token (theft detection) or Go unreachable — clear the
    // session so the request renders anonymous instead of retrying every request.
    const response = NextResponse.next({ request: { headers: forwardedRequest } })
    response.cookies.delete(ACCESS_COOKIE)
    response.cookies.delete(REFRESH_COOKIE)
    return withCsp(response, nonce)
  }
}
