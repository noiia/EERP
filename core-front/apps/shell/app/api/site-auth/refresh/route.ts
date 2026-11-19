import { NextResponse } from 'next/server'
import { ApiError } from '@eerp/core-front/server'
import { goAuthExchange } from '@/lib/bff'
import { identityFromAccessToken } from '@/lib/jwt'
import { clearSiteSessionCookies, readSiteRefreshToken, setSiteSessionCookies } from '@/lib/site-session'

// POST /api/site-auth/refresh — single-use rotation of the website session (ADR-024).
export async function POST() {
  const refreshToken = await readSiteRefreshToken()
  if (!refreshToken) {
    return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'No session' } }, { status: 401 })
  }
  try {
    const tokens = await goAuthExchange('refresh', { refresh_token: refreshToken }, 'website/auth')
    await setSiteSessionCookies(tokens)
    return NextResponse.json({ identity: identityFromAccessToken(tokens.accessToken) })
  } catch (e) {
    // Only Go's 401 means the session is dead. A 429/5xx/network blip must not
    // log the visitor out — keep the cookies and let the client retry.
    if (e instanceof ApiError) {
      if (e.status === 401) await clearSiteSessionCookies()
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status })
    }
    return NextResponse.json(
      { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Backend unreachable' } },
      { status: 502 },
    )
  }
}
