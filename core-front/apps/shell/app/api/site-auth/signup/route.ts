import { NextResponse } from 'next/server'
import { ApiError } from '@eerp/core-front/server'
import { goAuthExchange } from '@/lib/bff'
import { identityFromAccessToken } from '@/lib/jwt'
import { setSiteSessionCookies } from '@/lib/site-session'

// POST /api/site-auth/signup {email, password, name} — website visitor signup (ADR-024).
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string; name?: string }
  try {
    const tokens = await goAuthExchange('signup', { email: body.email, password: body.password, name: body.name }, 'website/auth')
    await setSiteSessionCookies(tokens)
    return NextResponse.json({ identity: identityFromAccessToken(tokens.accessToken) })
  } catch (e) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: { code: e.code, message: e.message, requestId: e.requestId } }, { status: e.status })
    }
    throw e
  }
}
