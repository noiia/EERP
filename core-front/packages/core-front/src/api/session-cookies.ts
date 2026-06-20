// Session cookie contract shared by the server ApiClient (refresh/clear) and the
// Phase 3 BFF auth routes (login sets them). Centralized so both sides agree on
// names, TTLs, and flags. The tokens live in HttpOnly cookies on the Next domain
// and never reach client JS (CONVENTIONS.md — session transport).

export const ACCESS_COOKIE = 'eerp_access'
export const REFRESH_COOKIE = 'eerp_refresh'

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

/** Flags applied to every session cookie write. Secure outside development only. */
export function sessionCookieOptions(maxAge: number): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  }
}
