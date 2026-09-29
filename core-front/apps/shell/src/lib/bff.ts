import 'server-only'
import { cookies, headers } from 'next/headers'
import {
  ACCESS_COOKIE,
  ACCESS_TTL_SECONDS,
  ApiError,
  GO_REFRESH_COOKIE,
  parseError,
  parseSetCookie,
  REFRESH_COOKIE,
  REFRESH_TTL_SECONDS,
  sessionCookieOptions,
} from '@eerp/core-front/server'

// BFF auth orchestration. The browser talks only to Next; Next exchanges credentials
// with Go server-side and holds the tokens in HttpOnly cookies on the Next domain. Go
// returns the access token in the JSON body and rotates the refresh token via a
// Set-Cookie header — never the body — so we read it from the response headers.

export type AuthBase = 'auth' | 'website/auth'

function authUrl(path: string, base: AuthBase = 'auth'): string {
  const apiBase = process.env.API_BASE
  if (!apiBase) throw new Error('API_BASE is not set — the BFF cannot reach the backend')
  const version = process.env.API_VERSION ?? '1'
  return `${apiBase}/api/v${version}/${base}/${path}`
}

/**
 * The browser's IP as the gateway reported it, to forward to Go: its rate
 * limiters key on the client IP, and without this every visitor would share the
 * BFF's own address (one global bucket). Go trusts only private-network hops,
 * so a client-supplied prefix cannot spoof it.
 */
export async function forwardedFor(explicit?: string): Promise<Record<string, string>> {
  // proxy.ts runs outside a request scope (no headers()): it passes the IP itself.
  if (explicit) return { 'X-Forwarded-For': explicit }
  try {
    const h = await headers()
    const ip = h.get('x-forwarded-for') ?? h.get('x-real-ip')
    return ip ? { 'X-Forwarded-For': ip } : {}
  } catch {
    return {} // outside a request scope: nothing to forward
  }
}

export interface TokenExchange {
  accessToken: string
  refreshToken?: string
  expiresIn: number
}

/**
 * POST to a Go auth endpoint. Throws ApiError (from the {error:{...}} envelope) on a
 * non-OK response. Returns the access token, the rotated refresh token (from Go's
 * Set-Cookie), and the access lifetime. `opts.forwardedFor` overrides the client IP
 * lookup (for callers outside a request scope, i.e. proxy.ts).
 */
export async function goAuthExchange(
  path: string,
  body: unknown,
  base: AuthBase = 'auth',
  opts: { forwardedFor?: string } = {},
): Promise<TokenExchange> {
  const res = await fetch(authUrl(path, base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await forwardedFor(opts.forwardedFor)) },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw await parseError(res)

  const data = (await res.json().catch(() => null)) as {
    access_token?: unknown
    expires_in?: unknown
  } | null
  if (!data || typeof data.access_token !== 'string') {
    throw new ApiError({ code: 'INTERNAL_ERROR', message: 'Malformed auth response', status: res.status })
  }

  return {
    accessToken: data.access_token,
    refreshToken: parseSetCookie(res.headers, GO_REFRESH_COOKIE),
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : ACCESS_TTL_SECONDS,
  }
}

/** Best-effort Go logout so the refresh token is revoked server-side. */
export async function goLogout(refreshToken: string, base: AuthBase = 'auth'): Promise<void> {
  try {
    await fetch(authUrl('logout', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await forwardedFor()) },
      body: JSON.stringify({ refresh_token: refreshToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // Logout is best-effort; clearing the local cookies is what matters to the client.
  }
}

export async function setSessionCookies(tokens: TokenExchange): Promise<void> {
  const store = await cookies()
  store.set(ACCESS_COOKIE, tokens.accessToken, sessionCookieOptions(tokens.expiresIn))
  if (tokens.refreshToken) {
    store.set(REFRESH_COOKIE, tokens.refreshToken, sessionCookieOptions(REFRESH_TTL_SECONDS))
  }
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies()
  store.delete(ACCESS_COOKIE)
  store.delete(REFRESH_COOKIE)
}

export async function readRefreshToken(): Promise<string | undefined> {
  return (await cookies()).get(REFRESH_COOKIE)?.value
}
