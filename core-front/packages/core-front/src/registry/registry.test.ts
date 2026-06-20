import { describe, expect, it } from 'vitest'
import type { ViewDescriptor } from '../views/descriptor'
import { ModuleRegistry, type FrontModule } from './registry'

const formDescriptor: ViewDescriptor = {
  entity: 'crm',
  viewType: 'form',
  fields: [{ name: 'name', label: 'Name', type: 'text' }],
}
const treeDescriptor: ViewDescriptor = { ...formDescriptor, viewType: 'tree' }

const crm: FrontModule = {
  name: 'crm',
  routes: [
    { path: '/crm/contacts', descriptor: treeDescriptor, permission: 'crm:contacts:read' },
    { path: '/crm/contacts/:id', descriptor: formDescriptor, permission: 'crm:contacts:read' },
  ],
}

describe('ModuleRegistry', () => {
  it('flattens a module into guarded route configs, preserving order', () => {
    const registry = new ModuleRegistry()
    registry.register(crm)

    const map = registry.buildRegistry()
    expect([...map.keys()]).toEqual(['/crm/contacts', '/crm/contacts/:id'])

    const list = map.get('/crm/contacts')
    expect(list).toEqual({ module: 'crm', descriptor: treeDescriptor, permission: 'crm:contacts:read' })
  })

  it('merges multiple modules in registration order', () => {
    const inventory: FrontModule = {
      name: 'inventory',
      routes: [{ path: '/inventory/items', descriptor: treeDescriptor }],
    }
    const registry = new ModuleRegistry()
    registry.register(crm).register(inventory)

    expect([...registry.buildRegistry().keys()]).toEqual([
      '/crm/contacts',
      '/crm/contacts/:id',
      '/inventory/items',
    ])
  })

  it('keeps permission undefined when a route declares none', () => {
    const registry = new ModuleRegistry()
    registry.register({ name: 'misc', routes: [{ path: '/misc', descriptor: formDescriptor }] })
    expect(registry.buildRegistry().get('/misc')?.permission).toBeUndefined()
  })
})

describe('ModuleRegistry.match', () => {
  const registry = new ModuleRegistry().register({
    name: 'crm',
    routes: [
      { path: '/crm/contacts', descriptor: treeDescriptor, permission: 'crm:contacts:read' },
      { path: '/crm/contacts/:id', descriptor: formDescriptor, permission: 'crm:contacts:read' },
    ],
  })

  it('matches an exact path with no params', () => {
    const match = registry.match('/crm/contacts')
    expect(match?.route.descriptor.viewType).toBe('tree')
    expect(match?.params).toEqual({})
  })

  it('matches a :param pattern and extracts the value', () => {
    const match = registry.match('/crm/contacts/42')
    expect(match?.route.descriptor.viewType).toBe('form')
    expect(match?.params).toEqual({ id: '42' })
  })

  it('returns null for an unregistered path', () => {
    expect(registry.match('/crm')).toBeNull()
    expect(registry.match('/crm/contacts/42/extra')).toBeNull()
  })
})
