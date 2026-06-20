import 'server-only'
import type { Identity } from '@eerp/core-front'

// Server-side session resolution. Phase 2 STUB: the real BFF session (HttpOnly
// cookie -> identity, resolved via next/headers) arrives in Phase 3. Until then
// there is no authenticated identity, so routes that declare a permission are denied
// and permission-less routes (the Phase 2 discovery fixture) still render.

export async function getIdentity(): Promise<Identity | null> {
  return null
}

export async function getEffectivePermissions(): Promise<string[]> {
  return (await getIdentity())?.permissions ?? []
}
