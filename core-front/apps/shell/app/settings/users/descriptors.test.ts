import { describe, expect, it } from 'vitest'
import {
  roleFormDescriptor,
  roleViewPermissionFormDescriptor,
  rolesListDescriptor,
  userFormDescriptor,
  usersDashboardDescriptor,
  usersDashboardListViews,
  usersListDescriptor,
} from './descriptors'

// The pages are thin RSC shells; the wiring worth guarding lives in these
// descriptors — entity/route pairing, row-click form paths, writable fields.

describe('Settings → Users descriptors', () => {
  it('rolls the dashboard up from the users and roles lists', () => {
    expect(usersDashboardDescriptor.viewType).toBe('dashboard')
    expect(usersDashboardListViews.map((v) => [v.entity, v.href])).toEqual([
      ['users', '/settings/users/accounts'],
      ['roles', '/settings/users/roles'],
    ])
  })

  it('lists users and opens an account form on row click', () => {
    expect(usersListDescriptor.entity).toBe('users')
    expect(usersListDescriptor.viewType).toBe('tree')
    expect(usersListDescriptor.formPath).toBe('/settings/users/accounts/:id')
  })

  it('lists roles and opens a role form on row click', () => {
    expect(rolesListDescriptor.entity).toBe('roles')
    expect(rolesListDescriptor.formPath).toBe('/settings/users/roles/:id')
  })

  it('exposes only the backend-writable fields on the forms', () => {
    // Go whitelists these on PUT (userWriteRequest/toProfile in
    // admin_handler.go); offering more would be dead inputs. `belongs` is the
    // one exception on the role form — a virtual many2many, stripped from the
    // PUT body and written instead through its own role_belongs junction
    // endpoint.
    expect(userFormDescriptor.fields.map((f) => f.name)).toEqual([
      'email',
      'username',
      'password',
      'name',
      'surname',
      'display_name',
      'job_title',
      'phone',
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

  it('puts the Views table as the first notebook tab, belongs on its own tab', () => {
    const notebook = roleFormDescriptor.layout?.find((n) => 'kind' in n && n.kind === 'notebook')
    expect(notebook && 'children' in notebook ? notebook.children.map((p) => 'title' in p ? p.title : undefined) : []).toEqual([
      'Views',
      'Settings',
      'Belongs',
    ])
  })

  it("opens a view's rights on its own dedicated form", () => {
    const field = roleFormDescriptor.fields.find((f) => f.name === 'view_permissions')
    expect(field?.relation?.entity).toBe('role_view_permission')
    expect(field?.relation?.inverseField).toBe('role_id')
    expect(field?.relation?.formPath).toBe('/settings/users/roles/rights/:id')
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

  it('gates Create on the write permissions — lists only, never the dashboard', () => {
    expect(usersListDescriptor.createPermission).toBe('users:users:write')
    expect(rolesListDescriptor.createPermission).toBe('roles:roles:write')
    expect(usersDashboardDescriptor.createPermission).toBeUndefined()
    expect(usersDashboardDescriptor.formPath).toBeUndefined()
  })
})
