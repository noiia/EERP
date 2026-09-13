import {
  FORM_COLUMNS_ID,
  FORM_HEADER_ID,
  FORM_NOTEBOOK_ID,
  PAGE_SETTINGS_ID,
  type ViewDescriptor,
} from '@eerp/core-front'
import type { AdminRecord } from './users_views'

// Accounts app — the `roles` entity. Same dedicated-admin-endpoint posture as
// users_views (Go's /api/v1/roles).

export const rolesListDescriptor: ViewDescriptor<AdminRecord> = {
  entity: 'roles',
  viewType: 'tree',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'text' },
  ],
  formPath: '/accounts/roles/:id',
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
      // The wizard falls back to a bare `entity` text field (labelField
      // below) and the row's `rights` tags are set afterward on its own
      // dedicated form (formPath).
      name: 'view_permissions',
      label: 'Views',
      type: 'relation',
      relation: {
        entity: 'role_view_permission',
        kind: 'one2many',
        inverseField: 'role_id',
        labelField: 'entity',
        formPath: '/accounts/roles/rights/:id',
      },
    },
  ],
  // Explicit layout so `view_permissions`/`belongs` get their own tabs
  // instead of landing in the synthesized default anatomy's two-column
  // group. "Views" is the FIRST notebook page per the feature request.
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
