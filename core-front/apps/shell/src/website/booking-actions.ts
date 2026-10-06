'use server'
import { revalidateTag } from 'next/cache'
import { goSiteFetch } from './account'
import { getJSON } from './public-api'

// Server Actions behind the site's booking UI (spec 4). Results are plain codes the
// client translates — Server Actions have no user locale.

export interface Slot { start: string; end: string; seats_left: number }

/** Bookable slots of a published appointment event in [from, to); null when the
 * event isn't bookable or the public API is rate-limited. Cached 60 s per window
 * (tag 'event'); a booking expires the tag, and Go's 409 is the truth anyway. */
export async function fetchSlots(eventId: string, from: string, to: string): Promise<Slot[] | null> {
  const q = new URLSearchParams({ from, to })
  const body = await getJSON<{ data: Slot[] }>(`/event/${encodeURIComponent(eventId)}/slots?${q}`, ['event'])
  return body?.data ?? null
}

export type TokenResult = 'ok' | 'invalid' | 'session' | 'taken' | 'failed' | null

/** The cancel link from a confirmation email: POST /website/bookings/cancel. */
export async function cancelByToken(_prev: TokenResult, form: FormData): Promise<TokenResult> {
  const res = await goSiteFetch('/website/bookings/cancel', {
    method: 'POST',
    body: JSON.stringify({ token: String(form.get('token') ?? '') }),
  }, 'none').catch(() => null)
  if (res?.ok) revalidateTag('event', { expire: 0 })
  return res?.ok ? 'ok' : res?.status === 404 ? 'invalid' : 'failed'
}

/** A waiting-list offer's link: POST /website/bookings/claim — 409 when the seat
 * went to someone faster (the visitor stays on the list). */
export async function claimByToken(_prev: TokenResult, form: FormData): Promise<TokenResult> {
  const res = await goSiteFetch('/website/bookings/claim', {
    method: 'POST',
    body: JSON.stringify({ token: String(form.get('token') ?? '') }),
  }, 'none').catch(() => null)
  if (res?.ok) revalidateTag('event', { expire: 0 })
  if (res?.ok) return 'ok'
  return res?.status === 404 ? 'invalid' : res?.status === 409 ? 'taken' : 'failed'
}

/** The verification link: POST /website/me/verify — only the signed-in owner can
 * use it, and only on a click (email scanners prefetch GET links). */
export async function verifyEmail(_prev: TokenResult, form: FormData): Promise<TokenResult> {
  const res = await goSiteFetch('/website/me/verify', {
    method: 'POST',
    body: JSON.stringify({ token: String(form.get('token') ?? '') }),
  }).catch(() => undefined)
  if (res === null || res?.status === 401) return 'session'
  return res?.ok ? 'ok' : res?.status === 400 ? 'invalid' : 'failed'
}

export async function resendVerification(): Promise<boolean> {
  const res = await goSiteFetch('/website/me/verify/resend', { method: 'POST' }).catch(() => null)
  return !!res?.ok
}

/** "Cancel" on /account: POST /website/me/bookings/:id/cancel (404 unless it's theirs). */
export async function cancelMyBooking(id: string): Promise<boolean> {
  const res = await goSiteFetch(`/website/me/bookings/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).catch(() => null)
  if (res?.ok) revalidateTag('event', { expire: 0 })
  return !!res?.ok
}
