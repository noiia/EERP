import 'server-only'
import { cookies } from 'next/headers'
import { forwardedFor } from '@/lib/bff'
import { SITE_ACCESS_COOKIE } from '@/lib/site-session'

// The visitor's own data at Go (/api/v1/website/me…), called server-side with the
// website access cookie as the bearer — the browser never holds the token.

export interface WebsiteMe { email: string; name: string; surname: string; phone: string; email_verified: boolean }

/** fetch against Go's /api/v1<path> for the site. `auth`: 'required' sends the
 * visitor's token and answers null without one; 'optional' sends it when present
 * (an anonymous booking); 'none' never does. */
export async function goSiteFetch(path: string, init: RequestInit = {}, auth: 'required' | 'optional' | 'none' = 'required'): Promise<Response | null> {
  const token = auth === 'none' ? undefined : (await cookies()).get(SITE_ACCESS_COOKIE)?.value
  if (auth === 'required' && !token) return null
  return fetch(`${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(await forwardedFor()) },
    cache: 'no-store',
  })
}

/** fetch against /website/me as the current visitor; null when there is no site session. */
export const meFetch = (init: RequestInit = {}) => goSiteFetch('/website/me', init)

/** The visitor's profile, or null when the session is missing or rejected. */
export async function getWebsiteMe(): Promise<WebsiteMe | null> {
  const res = await meFetch()
  if (!res) return null
  if (res.status === 401 || res.status === 404) return null
  if (!res.ok) throw new Error(`website/me: ${res.status}`)
  return (await res.json()) as WebsiteMe
}

export interface MyBooking {
  id: string
  event_id: string
  event_name: string
  start: string | null
  end: string | null
  seats: number
  status: 'confirmed' | 'cancelled'
}

/** The visitor's bookings (newest first); null without a valid site session. */
export async function getMyBookings(): Promise<MyBooking[] | null> {
  const res = await goSiteFetch('/website/me/bookings')
  if (!res || !res.ok) return null
  return ((await res.json()) as { data: MyBooking[] }).data
}
