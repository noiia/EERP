import 'server-only'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ACCESS_COOKIE, onSessionExpired } from '@eerp/core-front/server'
import type { Identity } from '@eerp/core-front'
import { identityFromAccessToken } from './jwt'

// Server-side session resolution for RSC + guards. Identity is derived from the
// HttpOnly access cookie (resolved via next/headers) — the token never reaches client
// JS. The client holds only a non-secret mirror (useSessionStore) for UI gating.

export async function getIdentity(): Promise<Identity | null> {
  const store = await cookies()
  return identityFromAccessToken(store.get(ACCESS_COOKIE)?.value)
}

export async function getEffectivePermissions(): Promise<string[]> {
  return (await getIdentity())?.permissions ?? []
}

/**
 * RequireAuth: redirect anonymous users to /login (carrying the intended path).
 * Returns the resolved identity for authenticated requests. Fine-grained authorization
 * is enforced by Go on every data call; the frontend gates on authentication here.
 */
export async function requireAuth(intendedPath?: string): Promise<Identity> {
  const identity = await getIdentity()
  if (!identity) {
    const next = intendedPath ? `?next=${encodeURIComponent(intendedPath)}` : ''
    redirect(`/login${next}`)
  }
  return identity
}

// When a data-call refresh fails (spent/rotated refresh = theft), the engine clears the
// session cookies; the next requireAuth() then redirects to /login. Nothing more to do
// here, but registering the hook documents the wiring and leaves room to extend it.
onSessionExpired(() => {})
