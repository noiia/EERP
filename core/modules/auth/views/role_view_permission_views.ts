import type { ViewDescriptor } from '@eerp/core-front'
import type { AdminRecord } from './users_views'

// role_view_permission's own dedicated form — needed for two reasons: it's
// what the Role form's "Views" tab one2many formPath opens when a row is
// clicked (to set that row's `rights` tags, which the create-wizard's bare
// fallback form can't offer), and it's a real registered ViewDescriptor the
// SAME way sale_line's own form exists purely to back its parent's one2many
// wizard/click-through.
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
