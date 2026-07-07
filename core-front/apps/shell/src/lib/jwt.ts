import 'server-only'
import type { Identity } from '@eerp/core-front'

// Decode the access JWT to build the session Identity. The token was issued by Go and
// stored by our BFF in an HttpOnly cookie, so we TRUST it here and only read claims —
// signature verification is Go's job (it validates the Bearer token on every API call).
// Go's claims: { sub: userId, tenant: tenantId, roles: [], permissions: [], exp }. The
// permissions claim carries the role-derived codes that light up <Can> and the Create
// buttons; it refreshes with the token (grant changes apply on the next issue), and it
// is UI gating only — Go re-authorizes every call from the database.

interface AccessClaims {
  sub?: string
  tenant?: string
  roles?: string[]
  permissions?: string[]
  exp?: number
}

function decodeBase64Url(segment: string): unknown {
  const padded = segment.padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=')
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
}

export function decodeAccessClaims(token: string): AccessClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return decodeBase64Url(parts[1]) as AccessClaims
  } catch {
    return null
  }
}

/**
 * Build an Identity from an access token, or null when the token is missing, malformed,
 * or expired. Expiry is checked so an elapsed access token reads as "logged out" in the
 * UI (the ApiClient still refreshes on data calls within Server Actions/route handlers).
 */
export function identityFromAccessToken(token: string | undefined): Identity | null {
  if (!token) return null
  const claims = decodeAccessClaims(token)
  if (!claims || typeof claims.sub !== 'string') return null
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return null
  return {
    userId: claims.sub,
    tenantId: typeof claims.tenant === 'string' ? claims.tenant : '',
    roles: Array.isArray(claims.roles) ? claims.roles : [],
    permissions: Array.isArray(claims.permissions) ? claims.permissions : [],
  }
}
