import 'server-only'
import { cookies } from 'next/headers'
import { forwardedFor } from '@/lib/bff'
import { SITE_ACCESS_COOKIE } from '@/lib/site-session'

// The visitor's own profile at Go (GET/PUT /api/v1/website/me), called server-side
// with the website access cookie as the bearer — the browser never holds the token.

export interface WebsiteMe { email: string; name: string; surname: string; phone: string; email_verified: boolean }

/** fetch against /website/me as the current visitor; null when there is no site session. */
export async function meFetch(init: RequestInit = {}): Promise<Response | null> {
  const token = (await cookies()).get(SITE_ACCESS_COOKIE)?.value
  if (!token) return null
  return fetch(`${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/website/me`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(await forwardedFor()) },
    cache: 'no-store',
  })
}

/** The visitor's profile, or null when the session is missing or rejected. */
export async function getWebsiteMe(): Promise<WebsiteMe | null> {
  const res = await meFetch()
  if (!res) return null
  if (res.status === 401 || res.status === 404) return null
  if (!res.ok) throw new Error(`website/me: ${res.status}`)
  return (await res.json()) as WebsiteMe
}
