'use client'
// Side-effect import: registers Settings → Users' own descriptors
// (app/settings/users/descriptors.ts) with the client moduleRegistry.
// Settings → Users is a hand-built page tree, never routed through the
// module catch-all, so nothing else registers these — but the relation
// widgets still need the registry for two independent lookups:
//   - role_view_permission's own form descriptor lets the Role form's
//     "Views" one2many create-wizard resolve entity (many2one) + rights
//     (many2many) together, in one popup, instead of falling back to a bare
//     one-field form on `entity` alone (ModuleRegistry.formDescriptorFor's
//     own doc comment).
//   - users/rolesListDescriptor's own `formPath` lets
//     moduleRegistry.formPathFor('users'|'roles') resolve, which is what
//     RelationTagsWidget/RelationSearchWidget's click-to-navigate reads —
//     without this, a many2many tag pointing at a user or role (e.g. the
//     User form's own `role` field) rendered but never navigated anywhere,
//     since formPathFor only ever searches REGISTERED routes, not just any
//     descriptor object sitting in this file.
// The `path` given for role_view_permission is only a lookup key for this
// map — Next's own file-based route at /settings/users/roles/rights/[id]
// still owns the real page. users/roles' own paths ARE their real Next
// pages (/settings/users/accounts, /settings/users/roles); registering them
// here changes nothing about which page renders them, since Next's
// file-based routing always wins over the module catch-all — this only
// makes those two paths resolvable through the registry's lookups. Mirrors
// ModulesInit's own "register at import time, render nothing" shape.
import { moduleRegistry, type FrontModule } from '@eerp/core-front'
import {
  roleViewPermissionFormDescriptor,
  rolesListDescriptor,
  usersListDescriptor,
} from '../../app/settings/users/descriptors'

const registryModule: FrontModule = {
  name: 'settings-users',
  routes: [
    {
      path: '/settings/users/roles/rights/:id',
      descriptor: roleViewPermissionFormDescriptor,
      permission: 'role_view_permission:role_view_permission:read',
    },
    {
      path: '/settings/users/accounts',
      descriptor: usersListDescriptor,
      permission: 'users:users:read',
    },
    {
      path: '/settings/users/roles',
      descriptor: rolesListDescriptor,
      permission: 'roles:roles:read',
    },
  ],
}
moduleRegistry.register(registryModule)

export function SettingsUsersRegistryInit() {
  return null
}
