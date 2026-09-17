import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { moduleRegistry } from '@eerp/core-front'
import { roleViewPermissionFormDescriptor } from '../../app/settings/users/descriptors'
import { SettingsUsersRegistryInit } from './SettingsUsersRegistryInit'

describe('SettingsUsersRegistryInit', () => {
  it('renders nothing — it only registers a descriptor', () => {
    const { container } = render(<SettingsUsersRegistryInit />)
    expect(container).toBeEmptyDOMElement()
  })

  it('makes the Role form Views wizard resolve role_view_permission to its real form', () => {
    // Importing the component module already ran the registration (side
    // effect at import time, mirroring ModulesInit) — this is what the
    // relation widgets' create-wizard calls to decide what to render.
    expect(moduleRegistry.formDescriptorFor('role_view_permission')).toBe(
      roleViewPermissionFormDescriptor,
    )
  })

  it('makes many2many tags pointing at a role or a user click-to-navigate (RelationTagsWidget reads formPathFor)', () => {
    // Without this registration, formPathFor found nothing for 'roles'/
    // 'users' even though rolesListDescriptor/usersListDescriptor declare
    // their own formPath — a many2many field like the User form's `role`
    // rendered its tags but a click never went anywhere.
    expect(moduleRegistry.formPathFor('roles')).toBe('/settings/users/roles/:id')
    expect(moduleRegistry.formPathFor('users')).toBe('/settings/users/accounts/:id')
  })
})
