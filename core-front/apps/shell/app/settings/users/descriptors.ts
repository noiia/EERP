import type { ViewDescriptor } from '@eerp/core-front'

// Settings → Users: descriptors only, like a module's views file — the engine
// derives the loaders, stores, and renderers. The entities map to the dedicated
// Go admin endpoints (/api/v1/users, /api/v1/roles — the auth tables are off the
// generic CRUD surface), which whitelist the mutable fields these forms edit.
// Field names are the JSON keys of the backend's admin DTOs.

/** The record shape at this boundary — the engine only needs HasId. */
export type AdminRecord = { id: string } & Record<string, unknown>

/** The dashboard blocks: one card per list, linking to it with its entry count. */
export const usersDashboardListViews = [
  { entity: 'users', title: 'Users', href: '/settings/users/accounts' },
  { entity: 'roles', title: 'Roles', href: '/settings/users/roles' },
]

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
    { name: 'created_at', label: 'Created', type: 'date' },
  ],
  // Clicking a row opens that user's form; Create opens it empty. A created
  // account starts LOCKED (no password) until a credential flow sets one.
  formPath: '/settings/users/accounts/:id',
  createPermission: 'users:users:write',
  permissions: ['users:users:read'],
}

// Email is the only field Go lets this form write; the rest of the record rides
// along in the draft and is ignored server-side.
export const userFormDescriptor: ViewDescriptor<AdminRecord> = {
  entity: 'users',
  viewType: 'form',
  fields: [{ name: 'email', label: 'Email', type: 'text', required: true }],
  permissions: ['users:users:read'],
}

export const rolesListDescriptor: ViewDescriptor<AdminRecord> = {
  entity: 'roles',
  viewType: 'tree',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'text' },
  ],
  formPath: '/settings/users/roles/:id',
  createPermission: 'roles:roles:write',
  permissions: ['roles:roles:read'],
}

export const roleFormDescriptor: ViewDescriptor<AdminRecord> = {
  entity: 'roles',
  viewType: 'form',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'text' },
  ],
  permissions: ['roles:roles:read'],
}
