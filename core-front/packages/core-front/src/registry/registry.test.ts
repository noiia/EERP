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

  it('is idempotent by module name — both manifests may evaluate during SSR', () => {
    const registry = new ModuleRegistry()
    registry.register(crm, { appMode: true })
    // The client manifest re-registering the same module is a no-op: routes are
    // not duplicated and the first registration's metadata (appMode) stands.
    registry.register(crm)
    expect([...registry.buildRegistry().keys()]).toEqual(['/crm/contacts', '/crm/contacts/:id'])
    expect(registry.menu()).toHaveLength(1)
  })

  it('resolves the first registered form descriptor for an entity', () => {
    const registry = new ModuleRegistry().register(crm)
    expect(registry.formDescriptorFor('crm')).toBe(formDescriptor)
    // Unknown entities (or entities with no form view) resolve to null — the
    // relation create wizard then falls back to its one-field labelField form.
    expect(registry.formDescriptorFor('tag')).toBeNull()
  })

  it('rejects a descriptor whose widget the field type forbids, naming module and route', () => {
    const bad: FrontModule = {
      name: 'broken',
      routes: [
        {
          path: '/broken',
          descriptor: {
            ...formDescriptor,
            fields: [{ name: 'rating', label: 'Rating', type: 'text', widget: 'stars' }],
          },
        },
      ],
    }
    expect(() => new ModuleRegistry().register(bad)).toThrowError(
      /module "broken", route "\/broken": field "rating"/,
    )
  })
})

describe('ModuleRegistry.menu', () => {
  it('lists navigable routes per app-mode module, dropping :param routes', () => {
    const registry = new ModuleRegistry().register(crm, { appMode: true })
    const menu = registry.menu()

    expect(menu).toEqual([
      {
        name: 'crm',
        routes: [{ path: '/crm/contacts', descriptor: treeDescriptor, permission: 'crm:contacts:read' }],
      },
    ])
  })

  it('omits modules not registered as applications, keeping their routes reachable', () => {
    const registry = new ModuleRegistry().register(crm)
    expect(registry.menu()).toEqual([])
    // No tile, but the routes are still registered and navigable.
    expect(registry.buildRegistry().has('/crm/contacts')).toBe(true)
  })

  it('omits app-mode modules whose every route needs a :param', () => {
    const registry = new ModuleRegistry().register(
      {
        name: 'detail-only',
        routes: [{ path: '/thing/:id', descriptor: formDescriptor }],
      },
      { appMode: true },
    )
    expect(registry.menu()).toEqual([])
  })

  it('preserves module registration order', () => {
    const inventory: FrontModule = {
      name: 'inventory',
      routes: [{ path: '/inventory/items', descriptor: treeDescriptor }],
    }
    const registry = new ModuleRegistry()
      .register(crm, { appMode: true })
      .register(inventory, { appMode: true })
    expect(registry.menu().map((m) => m.name)).toEqual(['crm', 'inventory'])
  })
})

describe('ModuleRegistry.moduleNav', () => {
  const dashboardDescriptor: ViewDescriptor = { ...formDescriptor, viewType: 'dashboard' }
  const navModule: FrontModule = {
    name: 'crm',
    routes: [
      { path: '/crm/dashboard', descriptor: dashboardDescriptor, permission: 'crm:contacts:read' },
      { path: '/crm/list', descriptor: treeDescriptor, permission: 'crm:contacts:read' },
      { path: '/crm/:id', descriptor: formDescriptor, permission: 'crm:contacts:read' },
    ],
  }

  it('exposes the module main pages it has, in canonical order, dropping non-main routes', () => {
    const nav = new ModuleRegistry().register(navModule).moduleNav()
    expect(nav).toEqual([
      {
        module: 'crm',
        pages: [
          { kind: 'dashboard', label: 'Dashboard', path: '/crm/dashboard', permission: 'crm:contacts:read' },
          { kind: 'list', label: 'List', path: '/crm/list', permission: 'crm:contacts:read' },
        ],
      },
    ])
  })

  it('includes a settings page when the module declares one', () => {
    const nav = new ModuleRegistry()
      .register({
        name: 'crm',
        routes: [
          { path: '/crm/list', descriptor: treeDescriptor },
          { path: '/crm/settings', descriptor: formDescriptor },
        ],
      })
      .moduleNav()
    expect(nav[0].pages.map((p) => p.kind)).toEqual(['list', 'settings'])
  })

  it('omits modules with no main pages', () => {
    const nav = new ModuleRegistry()
      .register({ name: 'crm', routes: [{ path: '/crm/:id', descriptor: formDescriptor }] })
      .moduleNav()
    expect(nav).toEqual([])
  })
})

describe('ModuleRegistry.listViews', () => {
  it('returns only the tree views of the named module', () => {
    const dashboardDescriptor: ViewDescriptor = { ...formDescriptor, viewType: 'dashboard' }
    const registry = new ModuleRegistry().register({
      name: 'crm',
      routes: [
        { path: '/crm/dashboard', descriptor: dashboardDescriptor },
        { path: '/crm/list', descriptor: treeDescriptor, permission: 'crm:contacts:read' },
        { path: '/crm/:id', descriptor: formDescriptor },
      ],
    })
    expect(registry.listViews('crm')).toEqual([
      { path: '/crm/list', descriptor: treeDescriptor, permission: 'crm:contacts:read' },
    ])
  })

  it('returns an empty list for an unknown module', () => {
    expect(new ModuleRegistry().listViews('nope')).toEqual([])
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
