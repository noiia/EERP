import { describe, expect, it, vi } from 'vitest'

// Mock the engine server barrel so this stays a pure resolution test (no server-only,
// no MUI, no next): the catch-all turns URL segments into a registry match.
const route = {
  module: 'demo',
  descriptor: { entity: 'demo', viewType: 'tree', fields: [] },
  permission: undefined,
}
vi.mock('@eerp/core-front/server', () => ({
  moduleRegistry: {
    match: (pathname: string) =>
      pathname === '/demo/items' ? { route, params: {} } : null,
  },
}))

import { modulePageTitle, modulePathFromSegments, resolveModuleRoute } from './resolve'

describe('modulePathFromSegments', () => {
  it('joins catch-all segments into a leading-slash path', () => {
    expect(modulePathFromSegments(['demo', 'items'])).toBe('/demo/items')
  })
})

describe('resolveModuleRoute', () => {
  it('resolves a registered path to its route match', () => {
    expect(resolveModuleRoute(['demo', 'items'])?.route.module).toBe('demo')
  })

  it('returns null for an unregistered path', () => {
    expect(resolveModuleRoute(['nope'])).toBeNull()
  })
})

describe('modulePageTitle', () => {
  it('titleizes the last path segment', () => {
    expect(modulePageTitle(['crm', 'contacts'], {})).toBe('Contacts')
  })

  it('drops :param (id) segments so a form route titles by its entity view', () => {
    expect(modulePageTitle(['crm', 'contacts', '42'], { id: '42' })).toBe('Contacts')
  })

  it('handles slugs with separators', () => {
    expect(modulePageTitle(['crm', 'sales_orders'], {})).toBe('Sales Orders')
  })
})
