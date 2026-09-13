import { describe, expect, it } from 'vitest'
import { usersDashboardDescriptor, usersListDescriptor, userFormDescriptor } from './users_views'
import { rolesListDescriptor, roleFormDescriptor } from './roles_views'
import { roleViewPermissionFormDescriptor } from './role_view_permission_views'

// The wiring worth guarding lives in these descriptors — entity/route
// pairing, row-click form paths, writable fields.

describe('Accounts app descriptors', () => {
  it('has a dashboard with no create affordance', () => {
    expect(usersDashboardDescriptor.viewType).toBe('dashboard')
    expect(usersDashboardDescriptor.createPermission).toBeUndefined()
    expect(usersDashboardDescriptor.formPath).toBeUndefined()
  })

  it('lists users and opens an account form on row click', () => {
    expect(usersListDescriptor.entity).toBe('users')
    expect(usersListDescriptor.viewType).toBe('tree')
    expect(usersListDescriptor.formPath).toBe('/accounts/:id')
    expect(usersListDescriptor.createPermission).toBe('users:users:write')
  })

  it('lists roles and opens a role form on row click', () => {
    expect(rolesListDescriptor.entity).toBe('roles')
    expect(rolesListDescriptor.formPath).toBe('/accounts/roles/:id')
    expect(rolesListDescriptor.createPermission).toBe('roles:roles:write')
  })

  it('exposes only the backend-writable fields on the forms, plus the roles many2many', () => {
    // Go whitelists these on PUT (userWriteRequest/toProfile in
    // admin_handler.go); offering more would be dead inputs. `role` (like
    // `belongs` on the role form) is the one exception — a virtual
    // many2many, stripped from the PUT body and written instead through its
    // own user_roles junction endpoint.
    expect(userFormDescriptor.fields.map((f) => f.name)).toEqual([
      'email',
      'username',
      'password',
      'name',
      'surname',
      'display_name',
      'job_title',
      'phone',
      'role',
      'address',
    ])
    expect(roleFormDescriptor.fields.map((f) => f.name)).toEqual([
      'name',
      'description',
      'technical_name',
      'belongs',
      'view_permissions',
    ])
    expect(roleViewPermissionFormDescriptor.fields.map((f) => f.name)).toEqual([
      'role_id',
      'entity',
      'rights',
    ])
  })

  it('places the roles many2many right after phone, over the user_roles junction', () => {
    const field = userFormDescriptor.fields.find((f) => f.name === 'role')
    expect(field?.type).toBe('relation')
    expect(field?.relation?.kind).toBe('many2many')
    expect(field?.relation?.entity).toBe('roles')
    expect(field?.relation?.via).toBe('user_roles')
    expect(field?.relation?.viaFields).toEqual({ own: 'user_id', related: 'role_id' })

    const names = userFormDescriptor.fields.map((f) => f.name)
    expect(names.indexOf('role')).toBe(names.indexOf('phone') + 1)
  })

  it('puts the Views table as the first notebook tab, belongs on its own tab', () => {
    const notebook = roleFormDescriptor.layout?.find((n) => 'kind' in n && n.kind === 'notebook')
    expect(
      notebook && 'children' in notebook
        ? notebook.children.map((p) => ('title' in p ? p.title : undefined))
        : [],
    ).toEqual(['Views', 'Settings', 'Belongs'])
  })

  it("opens a view's rights on its own dedicated form", () => {
    const field = roleFormDescriptor.fields.find((f) => f.name === 'view_permissions')
    expect(field?.relation?.entity).toBe('role_view_permission')
    expect(field?.relation?.inverseField).toBe('role_id')
    expect(field?.relation?.formPath).toBe('/accounts/roles/rights/:id')
  })

  it('picks the view from the live catalog, rights from a many2many tag', () => {
    const entityField = roleViewPermissionFormDescriptor.fields.find((f) => f.name === 'entity')
    expect(entityField?.type).toBe('relation')
    expect(entityField?.relation?.kind).toBe('many2one')
    expect(entityField?.relation?.entity).toBe('views')

    const rightsField = roleViewPermissionFormDescriptor.fields.find((f) => f.name === 'rights')
    expect(rightsField?.type).toBe('relation')
    expect(rightsField?.relation?.kind).toBe('many2many')
    expect(rightsField?.relation?.entity).toBe('account_role_types')
  })

  it('guards every view with the derived admin permissions', () => {
    expect(usersListDescriptor.permissions).toContain('users:users:read')
    expect(userFormDescriptor.permissions).toContain('users:users:read')
    expect(rolesListDescriptor.permissions).toContain('roles:roles:read')
    expect(roleFormDescriptor.permissions).toContain('roles:roles:read')
    expect(roleViewPermissionFormDescriptor.permissions).toContain(
      'role_view_permission:role_view_permission:read',
    )
  })
})
