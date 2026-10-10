import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { erpPath } from '@eerp/core-front'
import { goAuthExchange, setSessionCookies } from '@/lib/bff'
import { OIDC_COOKIE } from '@/lib/oidc'

// GET /api/auth/oidc/callback?code=&state= — the provider returns here. The
// state must match the cookie set by /start (CSRF); the cookie is always
// cleared; any failure lands on the login page with a generic message.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const jar = await cookies()
  const raw = jar.get(OIDC_COOKIE)?.value
  jar.delete(OIDC_COOKIE)
  const fail = NextResponse.redirect(new URL(erpPath('/login?error=sso'), request.url))

  let saved: {
    provider?: string
    state?: string
    nonce?: string
    verifier?: string
    next?: string
  } | null = null
  try {
    saved = raw ? JSON.parse(raw) : null
  } catch {
    saved = null
  }
  const code = params.get('code')
  if (
    !saved?.provider ||
    !saved.state ||
    !code ||
    params.get('error') ||
    params.get('state') !== saved.state
  )
    return fail

  try {
    const tokens = await goAuthExchange(
      `oidc/providers/${encodeURIComponent(saved.provider)}/exchange`,
      {
        code,
        code_verifier: saved.verifier,
        nonce: saved.nonce,
      },
    )
    await setSessionCookies(tokens)
  } catch {
    return fail
  }
  return NextResponse.redirect(new URL(erpPath(saved.next || '/'), request.url))
}
