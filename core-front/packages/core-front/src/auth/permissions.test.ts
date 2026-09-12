import { describe, expect, it } from 'vitest'
import { hasPermission } from './permissions'

describe('hasPermission', () => {
  const cases: Array<[string[], string, boolean]> = [
    [['crm:contacts:read'], 'crm:contacts:read', true],
    [['crm:contacts:read'], 'crm:contacts:write', false],
    [['crm:*:read'], 'crm:contacts:read', true],
    [['crm:*:read'], 'crm:contacts:write', false],
    [['*:*:read'], 'crm:contacts:read', true],
    [['*:*:read'], 'inventory:items:read', true],
    [['*:*:read'], 'crm:contacts:write', false],
    [['crm:*:*'], 'crm:contacts:delete', true],
    [[], 'crm:contacts:read', false],
    // segment count must match — a 2-segment grant doesn't cover a 3-segment need.
    [['crm:contacts'], 'crm:contacts:read', false],
    [['hr:employees:read', 'crm:*:read'], 'crm:contacts:read', true],
  ]

  it.each(cases)('grant %j for %s -> %s', (effective, required, expected) => {
    expect(hasPermission(effective, required)).toBe(expected)
  })
})
