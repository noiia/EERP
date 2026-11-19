import 'server-only'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ACCESS_COOKIE, erpPath, onSessionExpired } from '@eerp/core-front/server'
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

// The forced-change form's own route — the one page requireAuth must NOT
// redirect away from when mustChangePassword is set, or every render of that
// page would immediately bounce back to itself.
const FORCE_PASSWORD_CHANGE_PATH = erpPath('/force-password-change')

/**
 * RequireAuth: redirect anonymous users to the ERP login (carrying the intended path),
 * and a caller with a pending forced password change to FORCE_PASSWORD_CHANGE_PATH
 * (docs/security/pentest-2026-09-24.md's follow-up) — a UX convenience mirroring
 * what Go's PermissionMiddleware already enforces server-side on every data call;
 * this just keeps the rest of the app from rendering at all in the meantime.
 * `intendedPath` is module-relative ('/settings/users') or already under /app —
 * it is passed through erpPath(), so call sites never prefix it themselves.
 * Returns the resolved identity for authenticated requests. Fine-grained authorization
 * is enforced by Go on every data call; the frontend gates on authentication here.
 */
export async function requireAuth(intendedPath?: string): Promise<Identity> {
  const identity = await getIdentity()
  const intended = intendedPath ? erpPath(intendedPath) : undefined
  if (!identity) {
    const next = intended ? `?next=${encodeURIComponent(intended)}` : ''
    redirect(erpPath(`/login${next}`))
  }
  if (identity.mustChangePassword && intended !== FORCE_PASSWORD_CHANGE_PATH) {
    redirect(FORCE_PASSWORD_CHANGE_PATH)
  }
  return identity
}

// When a data-call refresh fails (spent/rotated refresh = theft), the engine clears the
// session cookies; the next requireAuth() then redirects to the ERP login. Nothing more to do
// here, but registering the hook documents the wiring and leaves room to extend it.
onSessionExpired(() => {})
