import { describe, expect, it, vi } from 'vitest'
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

describe('ModuleRegistry — view extensions (Phase 3)', () => {
  it('a second module reshapes a base view without the base changing', () => {
    const registry = new ModuleRegistry().register(crm)
    const extender: FrontModule = {
      name: 'crminheritdemo',
      routes: [],
      extends: [
        {
          path: '/crm/contacts/:id',
          operations: [
            { op: 'addField', field: { name: 'date', label: 'Date', type: 'date' }, target: 'name', position: 'after' },
            { op: 'setField', name: 'date', patch: { required: true } },
          ],
        },
      ],
    }
    registry.register(extender, { depends: ['crm'] })

    const resolved = registry.buildRegistry().get('/crm/contacts/:id')
    expect(resolved?.descriptor.fields.map((f) => f.name)).toEqual(['name', 'date'])
    expect(resolved?.descriptor.fields.find((f) => f.name === 'date')?.required).toBe(true)
    // The extender doesn't own the path — attribution stays with the base module.
    expect(resolved?.module).toBe('crm')
    // The original module-declared descriptor object is untouched (applyExtension is pure).
    expect(formDescriptor.fields).toHaveLength(1)
  })

  it('extending an unknown path throws, naming the module and path', () => {
    const registry = new ModuleRegistry()
    const extender: FrontModule = {
      name: 'ghost-extender',
      routes: [],
      extends: [{ path: '/nowhere', operations: [{ op: 'setDescriptor', patch: { formPath: '/x' } }] }],
    }
    expect(() => registry.register(extender)).toThrowError(
      /module "ghost-extender" extends unknown path "\/nowhere"/,
    )
  })

  it('a broken operation throws, wrapped with module + path context', () => {
    const registry = new ModuleRegistry().register(crm)
    const extender: FrontModule = {
      name: 'crminheritdemo',
      routes: [],
      extends: [
        { path: '/crm/contacts/:id', operations: [{ op: 'removeField', name: 'ghost' }] },
      ],
    }
    expect(() => registry.register(extender, { depends: ['crm'] })).toThrowError(
      /module "crminheritdemo" extending "\/crm\/contacts\/:id": removeField: field "ghost" not found/,
    )
  })

  it('an extension over an already-extended view composes: A extends B extends base', () => {
    const registry = new ModuleRegistry().register(crm)
    registry.register(
      {
        name: 'moduleB',
        routes: [],
        extends: [
          {
            path: '/crm/contacts/:id',
            operations: [{ op: 'addField', field: { name: 'date', label: 'Date', type: 'date' } }],
          },
        ],
      },
      { depends: ['crm'] },
    )
    registry.register(
      {
        name: 'moduleA',
        routes: [],
        extends: [
          {
            path: '/crm/contacts/:id',
            operations: [
              { op: 'addField', field: { name: 'comment', label: 'Comment', type: 'text' } },
              { op: 'move', name: 'comment', target: 'date', position: 'before' },
            ],
          },
        ],
      },
      { depends: ['moduleB'] },
    )

    const resolved = registry.buildRegistry().get('/crm/contacts/:id')
    expect(resolved?.descriptor.fields.map((f) => f.name)).toEqual(['name', 'date', 'comment'])
  })

  it('warns when a module extends a path it does not declare as a dependency', () => {
    const registry = new ModuleRegistry().register(crm)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registry.register(
      {
        name: 'sloppy',
        routes: [],
        extends: [
          { path: '/crm/contacts/:id', operations: [{ op: 'setDescriptor', patch: { formPath: '/x' } }] },
        ],
      },
      // No `depends` declared at all.
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('module "sloppy" extends path "/crm/contacts/:id"'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without declaring "crm"'))
    warn.mockRestore()
  })

  it('declaring the dependency silences the warning', () => {
    const registry = new ModuleRegistry().register(crm)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registry.register(
      {
        name: 'polite',
        routes: [],
        extends: [
          { path: '/crm/contacts/:id', operations: [{ op: 'setDescriptor', patch: { formPath: '/x' } }] },
        ],
      },
      { depends: ['crm'] },
    )
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('formDescriptorFor resolves the EXTENDED descriptor, not the original', () => {
    const registry = new ModuleRegistry().register(crm)
    registry.register(
      {
        name: 'crminheritdemo',
        routes: [],
        extends: [
          {
            path: '/crm/contacts/:id',
            operations: [{ op: 'addField', field: { name: 'comment', label: 'Comment', type: 'text' } }],
          },
        ],
      },
      { depends: ['crm'] },
    )
    expect(registry.formDescriptorFor('crm')?.fields.map((f) => f.name)).toEqual(['name', 'comment'])
  })

  it('re-registering the SAME module (idempotency) does not re-apply its extensions', () => {
    const registry = new ModuleRegistry().register(crm)
    const extender: FrontModule = {
      name: 'crminheritdemo',
      routes: [],
      extends: [
        { path: '/crm/contacts/:id', operations: [{ op: 'addField', field: { name: 'date', label: 'Date', type: 'date' } }] },
      ],
    }
    registry.register(extender, { depends: ['crm'] })
    registry.register(extender, { depends: ['crm'] }) // e.g. server + client manifest both evaluating during SSR
    expect(registry.buildRegistry().get('/crm/contacts/:id')?.descriptor.fields.map((f) => f.name)).toEqual([
      'name',
      'date',
    ])
  })

  it('a REPLACE (duplicate direct route registration) drops prior extensions on that path', () => {
    const registry = new ModuleRegistry().register(crm)
    registry.register(
      {
        name: 'crminheritdemo',
        routes: [],
        extends: [
          { path: '/crm/contacts/:id', operations: [{ op: 'addField', field: { name: 'date', label: 'Date', type: 'date' } }] },
        ],
      },
      { depends: ['crm'] },
    )
    expect(registry.buildRegistry().get('/crm/contacts/:id')?.descriptor.fields).toHaveLength(2)

    // A later module fully replacing the path — the blunt "last wins" escape
    // hatch — is a NEW view, not a merge; the earlier extension doesn't carry over.
    registry.register({
      name: 'replacer',
      routes: [{ path: '/crm/contacts/:id', descriptor: formDescriptor }],
    })
    expect(registry.buildRegistry().get('/crm/contacts/:id')?.descriptor.fields).toHaveLength(1)
  })
})
