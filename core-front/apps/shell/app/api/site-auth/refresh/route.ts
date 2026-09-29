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
    await clearSiteSessionCookies()
    if (e instanceof ApiError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status })
    }
    throw e
  }
}
