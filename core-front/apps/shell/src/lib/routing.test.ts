import { describe, expect, it } from 'vitest'
import { routeDecision } from './routing'

const erpRoots = new Set(['crm', 'settings', 'invoice'])
const path = { mode: 'path' as const }

describe('routeDecision — path mode', () => {
  it.each([
    ['/', { kind: 'next' }],
    ['/products', { kind: 'next' }],
    ['/app/crm/42', { kind: 'next' }],
    // Review Focus #3: old ERP bookmarks keep working.
    ['/crm/42', { kind: 'redirect', location: '/app/crm/42' }],
    ['/settings/users', { kind: 'redirect', location: '/app/settings/users' }],
    ['/api/v1/public/site', { kind: 'next' }],
    ['/print/report/x/1', { kind: 'next' }],
  ])('%s', (pathname, want) => {
    expect(routeDecision({ pathname, host: 'localhost', erpRoots, routing: path })).toEqual(want)
  })
})
