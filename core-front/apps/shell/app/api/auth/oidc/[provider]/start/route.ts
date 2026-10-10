import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { erpPath } from '@eerp/core-front'
import { forwardedFor } from '@/lib/bff'
import { OIDC_COOKIE } from '@/lib/oidc'

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    'base64url',
  )
}
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)))

// GET /api/auth/oidc/[provider]/start?next= — PKCE + state + nonce kept in a
// short-lived httpOnly cookie; Go builds the authorize URL (and its fixed
// redirect URI) from the auth settings.
export async function GET(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params
  const next = new URL(request.url).searchParams.get('next') ?? '/'
  const state = random()
  const nonce = random()
  const verifier = random()
  const challenge = b64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  )
  const fail = NextResponse.redirect(new URL(erpPath('/login?error=sso'), request.url))

  const qs = new URLSearchParams({ state, nonce, code_challenge: challenge })
  const res = await fetch(
    `${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/auth/oidc/providers/${encodeURIComponent(provider)}/authorize?${qs}`,
    { cache: 'no-store', headers: await forwardedFor(), signal: AbortSignal.timeout(5000) },
  ).catch(() => null)
  if (!res?.ok) return fail
  const body = (await res.json().catch(() => null)) as { url?: string } | null
  if (!body?.url) return fail
  ;(await cookies()).set(OIDC_COOKIE, JSON.stringify({ provider, state, nonce, verifier, next }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth/oidc',
    maxAge: 600,
  })
  return NextResponse.redirect(body.url)
}
