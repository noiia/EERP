// Session cookie contract shared by the server ApiClient (refresh/clear) and the
// Phase 3 BFF auth routes (login sets them). Centralized so both sides agree on
// names, TTLs, and flags. The tokens live in HttpOnly cookies on the Next domain
// and never reach client JS (CONVENTIONS.md — session transport).

export const ACCESS_COOKIE = 'eerp_access'
export const REFRESH_COOKIE = 'eerp_refresh'

/**
 * The cookie name Go sets its rotated refresh token under (HttpOnly, on the Go
 * domain). The BFF and the ApiClient read it from Go's Set-Cookie response header
 * and re-store it as REFRESH_COOKIE on the Next domain — Go does NOT return the
 * refresh token in the JSON body.
 */
export const GO_REFRESH_COOKIE = 'refresh_token'

/** access 1h, refresh 7d (refresh is single-use / rotated). */
export const ACCESS_TTL_SECONDS = 3600
export const REFRESH_TTL_SECONDS = 604800

export interface SessionCookieOptions {
  httpOnly: true
  secure: boolean
  sameSite: 'lax'
  path: '/'
  maxAge: number
}

/**
 * Flags applied to every session cookie write. Secure outside development only — UNLESS
 * COOKIE_SECURE explicitly overrides it. NODE_ENV=production (set by the Docker image)
 * means "this is a real build," not "this request arrived over TLS": a gateway that
 * terminates plain HTTP in front of the frontend (no cert configured yet) still runs the
 * production build, and a Secure cookie set over that connection is silently dropped by
 * the browser — login appears to succeed but no session survives the next navigation.
 * COOKIE_SECURE=false is how such a deployment opts out until TLS is added.
 */
export function sessionCookieOptions(maxAge: number): SessionCookieOptions {
  const secure =
    process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === 'true'
      : process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  }
}

/**
 * Extract a cookie value from a response's Set-Cookie headers by name. Used to read
 * Go's rotated `refresh_token` after login/refresh (it isn't in the JSON body).
 */
export function parseSetCookie(headers: Headers, name: string): string | undefined {
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  for (const cookie of cookies) {
    const pair = cookie.split(';', 1)[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === name) return decodeURIComponent(pair.slice(eq + 1).trim())
  }
  return undefined
}
