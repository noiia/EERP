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
          { name: 'owner_id', label: 'Owner', type: 'relation', relation: { entity: 'users', kind: 'many2one' } },
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
    '/appstore/:id',
    {
      module: 'appstore',
      descriptor: { entity: 'modules', viewType: 'form', fields: [], showChatter: false },
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
  [
    '/project/tasks',
    {
      module: 'project',
      descriptor: {
        entity: 'project_task',
        viewType: 'tree',
        fields: [
          { name: 'stage_id', label: 'Stage', type: 'relation', relation: { entity: 'project_stage', kind: 'many2one' } },
          { name: 'tag_ids', label: 'Tags', type: 'relation', relation: { entity: 'tag', kind: 'many2many' } },
        ],
        viewModeDefaults: { kanbanColumns: { orderField: 'sequence', labelField: 'name' } },
      },
      permission: undefined,
    },
  ],
  // A second tree path on the same entity (hierarchical + flat): the first wins.
  ['/crm/flat', { module: 'crm', descriptor: { entity: 'crm', viewType: 'tree', fields: [] }, permission: undefined }],
  [
    '/quote/:id',
    {
      module: 'sale',
      descriptor: {
        entity: 'quote',
        viewType: 'form',
        statusBar: { field: 'status' },
        fields: [
          { name: 'status', label: 'Status', type: 'selection', selection: { options: ['draft', 'sent'] } },
          { name: 'kind', type: 'selection', selection: { options: ['a'] } },
          { name: 'empty', label: 'Empty', type: 'selection', selection: { options: [] } },
          { name: 'name', label: 'Name', type: 'text' },
        ],
      },
      permission: undefined,
    },
  ],
  ['/quote/:id/copy', { module: 'sale', descriptor: { entity: 'quote', viewType: 'form', fields: [] }, permission: undefined }],
])
vi.mock('@eerp/core-front/server', () => ({
  moduleRegistry: { buildRegistry: () => routes },
}))

import { formViewEntities, treeViewEntities } from './registry'

describe('treeViewEntities', () => {
  it('lists only tree-view entities, not form/other viewTypes', () => {
    const entities = treeViewEntities().map((e) => e.entity)
    expect(entities).toEqual(['crm', 'roles', 'project_task'])
  })

  it('splits fields into kanban (selection) and calendar (date) candidates', () => {
    const crm = treeViewEntities().find((e) => e.entity === 'crm')
    expect(crm?.kanbanFields.map((f) => f.name)).toEqual(['status'])
    expect(crm?.dateFields.map((f) => f.name)).toEqual(['due_date'])
  })

  it('offers many2one fields as kanban candidates only when the module declares kanbanColumns', () => {
    expect(treeViewEntities().find((e) => e.entity === 'project_task')?.kanbanFields.map((f) => f.name)).toEqual(['stage_id'])
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

describe('formViewEntities', () => {
  it('lists only form-view entities, not tree/other viewTypes', () => {
    const entities = formViewEntities().map((e) => e.entity)
    expect(entities).toEqual(['crm', 'modules', 'quote'])
  })

  it('carries the owning module and the module\'s own showChatter default', () => {
    const crm = formViewEntities().find((e) => e.entity === 'crm')
    const modules = formViewEntities().find((e) => e.entity === 'modules')
    expect(crm?.module).toBe('crm')
    expect(crm?.showChatterDefault).toBeUndefined()
    expect(modules?.module).toBe('appstore')
    expect(modules?.showChatterDefault).toBe(false)
  })
})

describe('formViewEntities status bar', () => {
  it("carries the breadcrumb field and the form's selection fields that have options", () => {
    const quote = formViewEntities().find((e) => e.entity === 'quote')
    expect(quote?.statusBarField).toBe('status')
    expect(quote?.selectionFields).toEqual([
      { name: 'status', label: 'Status', options: ['draft', 'sent'] },
      { name: 'kind', label: 'kind', options: ['a'] }, // no label: its name
    ])
    expect(formViewEntities().find((e) => e.entity === 'crm')?.statusBarField).toBeUndefined()
  })

  it('keeps the first tree path of an entity', () => {
    expect(treeViewEntities().find((e) => e.entity === 'crm')?.kanbanFields.map((f) => f.name)).toEqual(['status'])
  })
})
