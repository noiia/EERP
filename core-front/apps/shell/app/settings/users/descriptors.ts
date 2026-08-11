import {
  FORM_COLUMNS_ID,
  FORM_HEADER_ID,
  FORM_NOTEBOOK_ID,
  PAGE_SETTINGS_ID,
  type ViewDescriptor,
} from '@eerp/core-front'

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
    {
      name: 'technical_name',
      label: 'Technical name',
      type: 'text',
      // Matched against a field's `groups` list (core/orm's WithFieldGroups)
      // for server-side field visibility — see docs/adr/ADR-013.
    },
    {
      // Self-referential many2many over the generic-CRUD-registered
      // role_belongs junction (core/internal/auth.RoleBelongs) — the roles
      // this role transitively inherits group access from (Odoo
      // implied_ids). Needs no bespoke widget: RelationTagsWidget/RelationOps
      // drive it purely from this descriptor.
      name: 'belongs',
      label: 'Belongs to',
      type: 'relation',
      relation: {
        entity: 'roles',
        kind: 'many2many',
        via: 'role_belongs',
        viaFields: { own: 'role_id', related: 'belongs_to_role_id' },
        labelField: 'name',
      },
    },
  ],
  // Explicit layout so `belongs` gets its own "Belongs" tab instead of
  // landing in the synthesized default anatomy's two-column group — the
  // header/columns/Settings-page nodes reuse the same well-known ids the
  // default synthesis would have used, so nothing else about the form's
  // appearance changes.
  layout: [
    { kind: 'row', id: FORM_HEADER_ID, children: [{ kind: 'field', name: 'name', variant: 'title' }] },
    {
      kind: 'group',
      id: FORM_COLUMNS_ID,
      columns: 2,
      children: [
        { kind: 'field', name: 'description' },
        { kind: 'field', name: 'technical_name' },
      ],
    },
    {
      kind: 'notebook',
      id: FORM_NOTEBOOK_ID,
      children: [
        { kind: 'page', id: PAGE_SETTINGS_ID, title: 'Settings', children: [] },
        { kind: 'page', title: 'Belongs', children: [{ kind: 'field', name: 'belongs' }] },
      ],
    },
  ],
  permissions: ['roles:roles:read'],
}
