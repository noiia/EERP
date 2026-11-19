import 'server-only'
import { cookies } from 'next/headers'
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, sessionCookieOptions } from '@eerp/core-front/server'
import type { Identity } from '@eerp/core-front'
import type { TokenExchange } from './bff'
import { identityFromAccessToken } from './jwt'

// Website (visitor) session — ADR-024. Deliberately separate cookies from the
// ERP session (eerp_access/eerp_refresh): a staff member can be logged in to
// both, and a website token must never be sent on an ERP call.
export const SITE_ACCESS_COOKIE = 'eerp_site_access'
export const SITE_REFRESH_COOKIE = 'eerp_site_refresh'

export async function getSiteIdentity(): Promise<Identity | null> {
  return identityFromAccessToken((await cookies()).get(SITE_ACCESS_COOKIE)?.value)
}

export async function setSiteSessionCookies(tokens: TokenExchange): Promise<void> {
  const store = await cookies()
  store.set(SITE_ACCESS_COOKIE, tokens.accessToken, sessionCookieOptions(tokens.expiresIn ?? ACCESS_TTL_SECONDS))
  if (tokens.refreshToken) {
    store.set(SITE_REFRESH_COOKIE, tokens.refreshToken, sessionCookieOptions(REFRESH_TTL_SECONDS))
  }
}

export async function clearSiteSessionCookies(): Promise<void> {
  const store = await cookies()
  store.delete(SITE_ACCESS_COOKIE)
  store.delete(SITE_REFRESH_COOKIE)
}

export async function readSiteRefreshToken(): Promise<string | undefined> {
  return (await cookies()).get(SITE_REFRESH_COOKIE)?.value
}
