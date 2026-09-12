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
    { name: 'username', label: 'Username', type: 'text', widget: 'username' },
    { name: 'display_name', label: 'Display name', type: 'text' },
    { name: 'created_at', label: 'Created', type: 'date' },
  ],
  // Clicking a row opens that user's form; Create opens it empty. A created
  // account starts LOCKED (no password) until a password is set on it.
  formPath: '/settings/users/accounts/:id',
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
// existed).
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
    { name: 'address', label: 'Address', type: 'address' },
  ],
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
    {
      // One row per "view" (entity) this role has any rights on — DATA MODEL
      // AND UI ONLY (core/internal/auth.RoleViewPermission's own doc
      // comment): not yet consulted by the actual module:resource:action
      // permission check, which stays role_permissions/role_belongs alone.
      // `role_view_permission` isn't a discovered module (no module.json —
      // deliberately, since toggling `auth` in the App Store would be able
      // to disable login itself), so it has no registered form for the
      // create-wizard to pick up; the wizard falls back to a bare `entity`
      // text field (labelField below) and the row's `rights` tags are set
      // afterward on its own dedicated form (formPath).
      name: 'view_permissions',
      label: 'Views',
      type: 'relation',
      relation: {
        entity: 'role_view_permission',
        kind: 'one2many',
        inverseField: 'role_id',
        labelField: 'entity',
        formPath: '/settings/users/roles/rights/:id',
      },
    },
  ],
  // Explicit layout so `view_permissions`/`belongs` get their own tabs
  // instead of landing in the synthesized default anatomy's two-column
  // group — the header/columns/Settings-page nodes reuse the same
  // well-known ids the default synthesis would have used, so nothing else
  // about the form's appearance changes. "Views" is the FIRST notebook page
  // per the feature request.
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
        { kind: 'page', title: 'Views', children: [{ kind: 'field', name: 'view_permissions' }] },
        { kind: 'page', id: PAGE_SETTINGS_ID, title: 'Settings', children: [] },
        { kind: 'page', title: 'Belongs', children: [{ kind: 'field', name: 'belongs' }] },
      ],
    },
  ],
  permissions: ['roles:roles:read'],
}

// role_view_permission's own dedicated form — needed for two reasons: it's
// what the "Views" tab's one2many formPath opens when a row is clicked (to
// set that row's `rights` tags, which the create-wizard's bare fallback form
// can't offer — see view_permissions' own comment above), and it's a real
// registered ViewDescriptor the SAME way sale_line's own form exists purely
// to back its parent's one2many wizard/click-through.
export const roleViewPermissionFormDescriptor: ViewDescriptor<AdminRecord> = {
  entity: 'role_view_permission',
  viewType: 'form',
  fields: [
    {
      name: 'role_id',
      label: 'Role',
      type: 'relation',
      required: true,
      relation: { entity: 'roles', kind: 'many2one', labelField: 'name' },
    },
    {
      // Picked from the live catalog of every generic-CRUD-registered
      // entity (GET /api/v1/views, core/internal/settings.GetViewCatalog) —
      // reflects exactly what's installed/compiled into this deployment,
      // rather than a freehand-typed string. Still just a plain string
      // column server-side (id === name in the catalog, both the entity's
      // own route prefix), so no migration or shape change was needed.
      name: 'entity',
      label: 'View',
      type: 'relation',
      required: true,
      relation: { entity: 'views', kind: 'many2one', labelField: 'name' },
    },
    {
      name: 'rights',
      label: 'Rights',
      type: 'relation',
      relation: {
        entity: 'account_role_types',
        kind: 'many2many',
        via: 'role_view_permission_right',
        viaFields: { own: 'role_view_permission_id', related: 'account_role_type_id' },
        labelField: 'name',
      },
    },
  ],
  permissions: ['role_view_permission:role_view_permission:read'],
}
