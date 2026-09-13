import type { ViewDescriptor } from '@eerp/core-front'

// Accounts app — the `users` entity. Bound to Go's dedicated admin endpoints
// (/api/v1/users — the auth tables stay off the generic CRUD surface;
// admin_handler.go whitelists exactly the fields these forms edit), which
// mimic the generic list envelope so the engine's ApiClient needs no special
// case.

export type AdminRecord = { id: string } & Record<string, unknown>

export const usersDashboardDescriptor: ViewDescriptor<AdminRecord> = {
  entity: 'users',
  viewType: 'dashboard',
  fields: [],
  permissions: ['users:users:read'],
}

export const usersListDescriptor: ViewDescriptor<AdminRecord> = {
  entity: 'users',
  viewType: 'tree',
  fields: [
    { name: 'email', label: 'Email', type: 'text', required: true },
    { name: 'username', label: 'Username', type: 'text', widget: 'username' },
    { name: 'display_name', label: 'Display name', type: 'text' },
    { name: 'created_at', label: 'Created', type: 'date' },
  ],
  // Clicking a row opens that user's form; Create opens it empty. A created
  // account starts LOCKED (no password) until a password is set on it.
  formPath: '/accounts/:id',
  createPermission: 'users:users:write',
  permissions: ['users:users:read'],
}

// Every field here is writable through Go's userWriteRequest (admin_handler.go) —
// email, the optional username handle (rendered with a leading "@" when the
// workspace's accounts.username_at_format setting is on — see
// core-front's accounts-store.ts), profile fields, the 7-column address
// composite (type: 'address' — see AddressWidget), and password (blank on an
// existing record means "leave the credential unchanged"; blank on a new
// record means the account is created LOCKED, same as before this field
// existed). `role` is the one exception: a virtual many2many over the
// user_roles junction (core/internal/auth.UserRoles — an Active
// Directory-style group membership, a user can hold several), stripped from
// the PUT body and written instead through its own generic-CRUD endpoint,
// same posture as roleFormDescriptor's `belongs`.
export const userFormDescriptor: ViewDescriptor<AdminRecord> = {
  entity: 'users',
  viewType: 'form',
  fields: [
    { name: 'email', label: 'Email', type: 'text', required: true },
    { name: 'username', label: 'Username', type: 'text', widget: 'username' },
    { name: 'password', label: 'Password', type: 'text', widget: 'password' },
    { name: 'name', label: 'First name', type: 'text' },
    { name: 'surname', label: 'Surname', type: 'text' },
    { name: 'display_name', label: 'Display name', type: 'text' },
    { name: 'job_title', label: 'Job title', type: 'text' },
    { name: 'phone', label: 'Phone', type: 'text', widget: 'phone' },
    {
      name: 'role',
      label: 'Roles',
      type: 'relation',
      relation: {
        entity: 'roles',
        kind: 'many2many',
        via: 'user_roles',
        viaFields: { own: 'user_id', related: 'role_id' },
        labelField: 'name',
      },
    },
    { name: 'address', label: 'Address', type: 'address' },
  ],
  permissions: ['users:users:read'],
}
