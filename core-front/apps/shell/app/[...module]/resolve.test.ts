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

import { modulePathFromSegments, resolveModuleRoute } from './resolve'

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
