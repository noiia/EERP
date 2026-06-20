import { describe, expect, it, vi } from 'vitest'

// Mock the engine server barrel so this stays a pure resolution test (no server-only,
// no MUI, no next): the catch-all turns URL segments into a registry lookup.
vi.mock('@eerp/core-front/server', () => {
  const registry = new Map([
    [
      '/demo/items',
      {
        module: 'demo',
        descriptor: { entity: 'demo', viewType: 'tree', fields: [] },
        permission: undefined,
      },
    ],
  ])
  return { moduleRegistry: { buildRegistry: () => registry } }
})

import { modulePathFromSegments, resolveModuleRoute } from './resolve'

describe('modulePathFromSegments', () => {
  it('joins catch-all segments into a leading-slash path', () => {
    expect(modulePathFromSegments(['demo', 'items'])).toBe('/demo/items')
  })
})

describe('resolveModuleRoute', () => {
  it('resolves a registered path to its route config', () => {
    expect(resolveModuleRoute(['demo', 'items'])?.module).toBe('demo')
  })

  it('returns undefined for an unregistered path', () => {
    expect(resolveModuleRoute(['nope'])).toBeUndefined()
  })
})
