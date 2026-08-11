import { describe, expect, it } from 'vitest'
import { identityFromAccessToken } from './jwt'

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`
}

const future = Math.floor(Date.now() / 1000) + 3600
const past = Math.floor(Date.now() / 1000) - 60

describe('identityFromAccessToken', () => {
  it('builds identity from the access claims', () => {
    const token = makeJwt({ sub: 'u1', tenant: 't1', roles: ['admin'], exp: future })
    expect(identityFromAccessToken(token)).toEqual({
      userId: 'u1',
      tenantId: 't1',
      roles: ['admin'],
      groups: [],
      permissions: [],
    })
  })

  it('reads a permissions claim when present (forward-compatible)', () => {
    const token = makeJwt({ sub: 'u1', tenant: 't1', roles: [], permissions: ['crm:*:read'], exp: future })
    expect(identityFromAccessToken(token)?.permissions).toEqual(['crm:*:read'])
  })

  it('reads a groups claim when present', () => {
    const token = makeJwt({ sub: 'u1', tenant: 't1', roles: [], groups: ['pricing'], exp: future })
    expect(identityFromAccessToken(token)?.groups).toEqual(['pricing'])
  })

  it('returns null for an expired token', () => {
    expect(identityFromAccessToken(makeJwt({ sub: 'u1', exp: past }))).toBeNull()
  })

  it('returns null for a missing or malformed token', () => {
    expect(identityFromAccessToken(undefined)).toBeNull()
    expect(identityFromAccessToken('only.two')).toBeNull()
    expect(identityFromAccessToken('a.b.c')).toBeNull()
  })
})
