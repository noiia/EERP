'use client'
// Side-effect import: registers role_view_permission's own form descriptor
// (app/settings/users/descriptors.ts) with the client moduleRegistry so the
// Role form's "Views" one2many create-wizard resolves it — entity (many2one)
// + rights (many2many) together, in one popup — instead of falling back to
// a bare one-field form on `entity` alone (see
// ModuleRegistry.formDescriptorFor's own doc comment). Settings → Users is a
// hand-built page tree, never routed through the module catch-all, so
// nothing else registers this descriptor. The `path` given here is only a
// lookup key for this map: Next's own file-based route at
// /settings/users/roles/rights/[id] still owns the real page, and the
// catch-all never sees this path since Next resolves the concrete page
// first. Mirrors ModulesInit's own "register at import time, render
// nothing" shape.
import { moduleRegistry, type FrontModule } from '@eerp/core-front'
import { roleViewPermissionFormDescriptor } from '../../app/settings/users/descriptors'

const registryModule: FrontModule = {
  name: 'settings-users-role-view-permission',
  routes: [
    {
      path: '/settings/users/roles/rights/:id',
      descriptor: roleViewPermissionFormDescriptor,
      permission: 'role_view_permission:role_view_permission:read',
    },
  ],
}
moduleRegistry.register(registryModule)

export function SettingsUsersRegistryInit() {
  return null
}
