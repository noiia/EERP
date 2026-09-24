import { requireAuth } from '@/lib/session'
import { getMyUserProfile } from '@/lib/force-password-change'
import PasswordChangeForm from './PasswordChangeForm'

// docs/security/pentest-2026-09-24.md's follow-up: a freshly-seeded default admin
// in production mode is forced here (requireAuth redirects any identity with
// mustChangePassword set) before it can reach anything else — Go's
// PermissionMiddleware enforces the same gate server-side, so this page existing
// is a UX convenience, not the actual security boundary.
export default async function ForcePasswordChangePage() {
  const identity = await requireAuth('/force-password-change')
  const profile = await getMyUserProfile(identity.userId)
  return <PasswordChangeForm profile={profile} />
}
