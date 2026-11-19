import { describe, expect, it } from 'vitest'
import { erpPath } from './navigation'

describe('erpPath', () => {
  it.each([
    ['/crm/42', '/app/crm/42'],
    ['/', '/app'],
    ['/settings/users?tab=roles', '/app/settings/users?tab=roles'],
    ['/app/crm', '/app/crm'], // idempotent
    ['/app', '/app'],
    ['/apple/1', '/app/apple/1'], // a module named "apple" is not already prefixed
    ['/crm#notes', '/app/crm#notes'],
    ['/login?next=%2Fcrm', '/app/login?next=%2Fcrm'],
  ])('%s -> %s', (input, want) => expect(erpPath(input)).toBe(want))
})
