import { NextResponse } from 'next/server'
import { goLogout } from '@/lib/bff'
import { clearSiteSessionCookies, readSiteRefreshToken } from '@/lib/site-session'

// POST /api/site-auth/logout — best-effort revoke at Go, then clear the site cookies.
export async function POST() {
  const refreshToken = await readSiteRefreshToken()
  if (refreshToken) await goLogout(refreshToken, 'website/auth')
  await clearSiteSessionCookies()
  return new NextResponse(null, { status: 204 })
}
