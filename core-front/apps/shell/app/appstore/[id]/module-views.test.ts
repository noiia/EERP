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
  it("lists every path the module OWNS as a 'Created' row, attributed to the given file", () => {
    extendedPathsMock.mockReturnValue([])
    expect(moduleViewRows('crm', 'CrmViews.ts')).toEqual([
      { view: '/crm', file: 'CrmViews.ts', kind: 'Created' },
      { view: '/crm/list', file: 'CrmViews.ts', kind: 'Created' },
      { view: '/crm/:id', file: 'CrmViews.ts', kind: 'Created' },
    ])
  })

  it("lists the module's own extended paths as 'Edited' rows, after the created ones", () => {
    extendedPathsMock.mockReturnValue(['/crm/:id', '/crm/list'])
    expect(moduleViewRows('crminheritdemo', 'CrmInheritViews.ts')).toEqual([
      { view: '/crm/:id', file: 'CrmInheritViews.ts', kind: 'Edited' },
      { view: '/crm/list', file: 'CrmInheritViews.ts', kind: 'Edited' },
    ])
  })

  it('is empty for a module that owns nothing and extends nothing', () => {
    extendedPathsMock.mockReturnValue([])
    expect(moduleViewRows('nope', 'Nope.ts')).toEqual([])
  })
})
