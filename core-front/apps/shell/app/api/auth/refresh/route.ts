import { NextResponse } from 'next/server'
import { ApiError } from '@eerp/core-front/server'
import { clearSessionCookies, goAuthExchange, readRefreshToken, setSessionCookies } from '@/lib/bff'
import { identityFromAccessToken } from '@/lib/jwt'

// POST /api/auth/refresh — single-use rotation. A reused/spent refresh trips Go's theft
// detection (401); we clear the local cookies so the next request is anonymous.
export async function POST() {
  const refreshToken = await readRefreshToken()
  if (!refreshToken) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'No session' } },
      { status: 401 },
    )
  }

  try {
    const tokens = await goAuthExchange('refresh', { refresh_token: refreshToken })
    await setSessionCookies(tokens)
    return NextResponse.json({ identity: identityFromAccessToken(tokens.accessToken) })
  } catch (e) {
    await clearSessionCookies()
    if (e instanceof ApiError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status })
    }
    throw e
  }
}
