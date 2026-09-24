'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Backs the forced credential-change form (docs/security/pentest-2026-09-24.md's
// follow-up): the ONE write path PermissionMiddleware still allows a caller with
// must_change_password set (core/internal/middleware/permission.go's
// isSelfCredentialRoute) is PUT /users/:id on their OWN id — the same dedicated
// admin endpoint Settings -> Users already uses, not a new backend route.

export type SaveResult = { ok: true } | { ok: false; message: string }

// Mirrors Go's adminUserResponse / userWriteRequest (core/internal/auth/admin_handler.go)
// minus password_hash, which never serializes. UpdateProfile WHITELISTS every one
// of these fields on write (it doesn't patch) — a field left out of the PUT body
// would blank the existing value, so the full profile round-trips even though
// this form only ever lets the caller change email/password.
export interface SelfUserProfile {
  id: string
  email: string
  username: string | null
  name: string
  surname: string
  display_name: string
  job_title: string
  phone: string
  address_number: number | null
  address_complement: string
  address_street: string
  address_zip_code: string
  address_city: string
  address_state: string
  address_country: string
}

/** Read the caller's own profile, to prefill the forced password-change form. */
export async function getMyUserProfile(userId: string): Promise<SelfUserProfile | null> {
  try {
    return await apiRequest<SelfUserProfile>('GET', `/users/${userId}`)
  } catch {
    return null
  }
}

/**
 * Set a new password (and optionally a new email) on the caller's own account.
 * Go clears must_change_password as soon as a real password change lands
 * (UserRepository.UpdateProfile) — no separate "clear the flag" call needed.
 */
export async function changeMyPassword(
  profile: SelfUserProfile,
  newPassword: string,
  newEmail: string,
): Promise<SaveResult> {
  try {
    await apiRequest('PUT', `/users/${profile.id}`, {
      email: newEmail.trim() || profile.email,
      password: newPassword,
      username: profile.username,
      name: profile.name,
      surname: profile.surname,
      display_name: profile.display_name,
      job_title: profile.job_title,
      phone: profile.phone,
      address_number: profile.address_number,
      address_complement: profile.address_complement,
      address_street: profile.address_street,
      address_zip_code: profile.address_zip_code,
      address_city: profile.address_city,
      address_state: profile.address_state,
      address_country: profile.address_country,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : 'Could not change your password.' }
  }
}
