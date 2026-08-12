import { describe, expect, it, vi } from 'vitest'

// Mock the engine server barrel so this stays a pure resolution test (no
// server-only, no MUI, no next) — mirrors [...module]/resolve.test.ts.
const routes = new Map([
  [
    '/crm/list',
    {
      module: 'crm',
      descriptor: {
        entity: 'crm',
        viewType: 'tree',
        fields: [
          { name: 'status', label: 'Status', type: 'selection', selection: { options: ['open'] } },
          { name: 'due_date', label: 'Due date', type: 'date' },
          { name: 'name', label: 'Name', type: 'text' },
        ],
        viewModeDefaults: { kanbanStatusField: 'status', enableGraphs: true },
      },
      permission: undefined,
    },
  ],
  [
    '/crm/:id',
    {
      module: 'crm',
      descriptor: { entity: 'crm', viewType: 'form', fields: [] },
      permission: undefined,
    },
  ],
  [
    '/settings/users/roles',
    {
      module: 'users',
      descriptor: {
        entity: 'roles',
        viewType: 'tree',
        fields: [{ name: 'name', label: 'Name', type: 'text' }],
      },
      permission: undefined,
    },
  ],
])
vi.mock('@eerp/core-front/server', () => ({
  moduleRegistry: { buildRegistry: () => routes },
}))

import { treeViewEntities } from './registry'

describe('treeViewEntities', () => {
  it('lists only tree-view entities, not form/other viewTypes', () => {
    const entities = treeViewEntities().map((e) => e.entity)
    expect(entities).toEqual(['crm', 'roles'])
  })

  it('splits fields into kanban (selection) and calendar (date) candidates', () => {
    const crm = treeViewEntities().find((e) => e.entity === 'crm')
    expect(crm?.kanbanFields.map((f) => f.name)).toEqual(['status'])
    expect(crm?.dateFields.map((f) => f.name)).toEqual(['due_date'])
  })

  it('an entity with neither a selection nor a date field gets empty choice lists', () => {
    const roles = treeViewEntities().find((e) => e.entity === 'roles')
    expect(roles?.kanbanFields).toEqual([])
    expect(roles?.dateFields).toEqual([])
  })

  it('carries the owning module — the caller filters on this against live active state', () => {
    const crm = treeViewEntities().find((e) => e.entity === 'crm')
    const roles = treeViewEntities().find((e) => e.entity === 'roles')
    expect(crm?.module).toBe('crm')
    expect(roles?.module).toBe('users')
  })

  it("carries the module's own viewModeDefaults, {} when it declared none", () => {
    const crm = treeViewEntities().find((e) => e.entity === 'crm')
    const roles = treeViewEntities().find((e) => e.entity === 'roles')
    expect(crm?.defaults).toEqual({ kanbanStatusField: 'status', enableGraphs: true })
    expect(roles?.defaults).toEqual({})
  })
})
