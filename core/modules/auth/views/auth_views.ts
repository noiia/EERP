import type { FrontModule } from '@eerp/core-front'
import { usersDashboardDescriptor, usersListDescriptor, userFormDescriptor } from './users_views'
import { rolesListDescriptor, roleFormDescriptor } from './roles_views'
import { roleViewPermissionFormDescriptor } from './role_view_permission_views'

// Assembler: the Accounts app (module.json app_mode: true) — user accounts,
// roles, and a role's per-view rights, exactly like any other app module.
// The dashboard route is first so the landing-menu tile opens it.
const auth: FrontModule = {
  name: 'auth',
  routes: [
    { path: '/accounts', descriptor: usersDashboardDescriptor },
    { path: '/accounts/list', descriptor: usersListDescriptor },
    { path: '/accounts/:id', descriptor: userFormDescriptor },
    { path: '/accounts/roles', descriptor: rolesListDescriptor },
    { path: '/accounts/roles/:id', descriptor: roleFormDescriptor },
    { path: '/accounts/roles/rights/:id', descriptor: roleViewPermissionFormDescriptor },
  ],
}

export default auth
