import 'server-only'
import { redirect } from 'next/navigation'
import { ApiError } from '../api/errors'
import { hasPermission } from './permissions'

// Server-side authorization for RSC + route handlers. The host resolves the user's
// effective permissions from the session (server-side, Phase 3) and calls this. When
// the permission is missing it either redirects (e.g. to /login or a 403 page) or
// throws a FORBIDDEN ApiError for the caller to translate to a 403 response.

export interface RequirePermissionOptions {
  /** When set, redirect here on denial instead of throwing. */
  redirectTo?: string
}

export function requirePermission(
  effective: string[],
  required: string,
  options: RequirePermissionOptions = {},
): void {
  if (hasPermission(effective, required)) return
  if (options.redirectTo) redirect(options.redirectTo)
  throw new ApiError({
    code: 'FORBIDDEN',
    message: `Missing permission: ${required}`,
    status: 403,
  })
}
