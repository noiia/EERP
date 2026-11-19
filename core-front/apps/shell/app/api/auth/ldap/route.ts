import { NextResponse } from 'next/server'
import { ApiError } from '@eerp/core-front/server'
import { goAuthExchange, setSessionCookies } from '@/lib/bff'
import { identityFromAccessToken } from '@/lib/jwt'

// POST /api/auth/ldap {username, password} — directory sign-in, same cookie
// handling as /api/auth/login.
export async function POST(request: Request) {
  const body = ((await request.json().catch(() => null)) ?? {}) as {
    username?: string
    password?: string
  }
  try {
    const tokens = await goAuthExchange('ldap/login', {
      username: body.username,
      password: body.password,
    })
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
