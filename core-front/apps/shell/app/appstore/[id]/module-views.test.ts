import { describe, expect, it, vi } from 'vitest'

// Mock the engine server barrel so this stays a pure resolution test (no
// server-only, no MUI, no next) — mirrors settings/views/registry.test.ts.
const routes = new Map([
  ['/crm', { module: 'crm', descriptor: { entity: 'crm', viewType: 'dashboard', fields: [] } }],
  ['/crm/list', { module: 'crm', descriptor: { entity: 'crm', viewType: 'tree', fields: [] } }],
  ['/crm/:id', { module: 'crm', descriptor: { entity: 'crm', viewType: 'form', fields: [] } }],
])
const extendedPathsMock = vi.fn()
vi.mock('@eerp/core-front/server', () => ({
  moduleRegistry: {
    buildRegistry: () => routes,
    extendedPaths: (name: string) => extendedPathsMock(name),
  },
}))

import { moduleViewRows } from './module-views'

describe('moduleViewRows', () => {
  it("lists every path the module OWNS as a 'Created' row, with filename/filepath", () => {
    extendedPathsMock.mockReturnValue([])
    expect(moduleViewRows('crm', 'CrmViews.ts', '/repo/core/modules/crm')).toEqual([
      { route: '/crm', filename: 'CrmViews.ts', filepath: '/repo/core/modules/crm/views/CrmViews.ts', status: 'Created' },
      { route: '/crm/list', filename: 'CrmViews.ts', filepath: '/repo/core/modules/crm/views/CrmViews.ts', status: 'Created' },
      { route: '/crm/:id', filename: 'CrmViews.ts', filepath: '/repo/core/modules/crm/views/CrmViews.ts', status: 'Created' },
    ])
  })

  it("lists the module's own extended paths as 'Inherited' rows, after the created ones", () => {
    extendedPathsMock.mockReturnValue(['/crm/:id', '/crm/list'])
    expect(moduleViewRows('crminheritdemo', 'CrmInheritViews.ts', '/repo/core/modules/crminheritdemo')).toEqual([
      {
        route: '/crm/:id',
        filename: 'CrmInheritViews.ts',
        filepath: '/repo/core/modules/crminheritdemo/views/CrmInheritViews.ts',
        status: 'Inherited',
      },
      {
        route: '/crm/list',
        filename: 'CrmInheritViews.ts',
        filepath: '/repo/core/modules/crminheritdemo/views/CrmInheritViews.ts',
        status: 'Inherited',
      },
    ])
  })

  it('falls back to the bare filename when moduleDir is not given', () => {
    extendedPathsMock.mockReturnValue([])
    expect(moduleViewRows('crm', 'CrmViews.ts')).toEqual([
      { route: '/crm', filename: 'CrmViews.ts', filepath: 'CrmViews.ts', status: 'Created' },
      { route: '/crm/list', filename: 'CrmViews.ts', filepath: 'CrmViews.ts', status: 'Created' },
      { route: '/crm/:id', filename: 'CrmViews.ts', filepath: 'CrmViews.ts', status: 'Created' },
    ])
  })

  it('is empty for a module that owns nothing and extends nothing', () => {
    extendedPathsMock.mockReturnValue([])
    expect(moduleViewRows('nope', 'Nope.ts')).toEqual([])
  })
})
