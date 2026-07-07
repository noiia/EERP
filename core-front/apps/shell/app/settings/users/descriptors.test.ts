import { describe, expect, it } from 'vitest'
import {
  roleFormDescriptor,
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
    // Go whitelists these on PUT; offering more would be dead inputs.
    expect(userFormDescriptor.fields.map((f) => f.name)).toEqual(['email'])
    expect(roleFormDescriptor.fields.map((f) => f.name)).toEqual(['name', 'description'])
  })

  it('guards every view with the derived admin permissions', () => {
    expect(usersListDescriptor.permissions).toContain('users:users:read')
    expect(userFormDescriptor.permissions).toContain('users:users:read')
    expect(rolesListDescriptor.permissions).toContain('roles:roles:read')
    expect(roleFormDescriptor.permissions).toContain('roles:roles:read')
  })

  it('gates Create on the write permissions — lists only, never the dashboard', () => {
    expect(usersListDescriptor.createPermission).toBe('users:users:write')
    expect(rolesListDescriptor.createPermission).toBe('roles:roles:write')
    expect(usersDashboardDescriptor.createPermission).toBeUndefined()
    expect(usersDashboardDescriptor.formPath).toBeUndefined()
  })
})
