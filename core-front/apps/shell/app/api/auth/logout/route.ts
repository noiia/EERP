import { NextResponse } from 'next/server'
import { clearSessionCookies, goLogout, readRefreshToken } from '@/lib/bff'

// POST /api/auth/logout — best-effort revoke at Go, then clear the local session cookies.
export async function POST() {
  const refreshToken = await readRefreshToken()
  if (refreshToken) await goLogout(refreshToken)
  await clearSessionCookies()
  return new NextResponse(null, { status: 204 })
}
