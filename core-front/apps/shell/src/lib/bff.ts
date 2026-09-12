import 'server-only'
import { cookies } from 'next/headers'
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

function authUrl(path: string): string {
  const base = process.env.API_BASE
  if (!base) throw new Error('API_BASE is not set — the BFF cannot reach the backend')
  const version = process.env.API_VERSION ?? '1'
  return `${base}/api/v${version}/auth/${path}`
}

export interface TokenExchange {
  accessToken: string
  refreshToken?: string
  expiresIn: number
}

/**
 * POST to a Go auth endpoint. Throws ApiError (from the {error:{...}} envelope) on a
 * non-OK response. Returns the access token, the rotated refresh token (from Go's
 * Set-Cookie), and the access lifetime.
 */
export async function goAuthExchange(path: string, body: unknown): Promise<TokenExchange> {
  const res = await fetch(authUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
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
export async function goLogout(refreshToken: string): Promise<void> {
  try {
    await fetch(authUrl('logout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      cache: 'no-store',
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
