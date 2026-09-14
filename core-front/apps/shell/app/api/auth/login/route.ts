import { NextResponse } from 'next/server'
import { ApiError } from '@eerp/core-front/server'
import { goAuthExchange, setSessionCookies } from '@/lib/bff'
import { identityFromAccessToken } from '@/lib/jwt'

// POST /api/auth/login {email, password}
// Exchanges credentials with Go, stores the tokens in HttpOnly cookies on the Next
// domain, and returns the non-secret identity for the client session mirror.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string }

  try {
    const tokens = await goAuthExchange('login', { email: body.email, password: body.password })
    await setSessionCookies(tokens)
    return NextResponse.json({ identity: identityFromAccessToken(tokens.accessToken) })
  } catch (e) {
    if (e instanceof ApiError) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message, requestId: e.requestId } },
        { status: e.status },
      )
    }
    throw e
  }
}
