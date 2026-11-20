import { expect, it, vi } from 'vitest'

const apiRequest = vi.fn()
vi.mock('@eerp/core-front/server', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }))

import { checkAuthorization, decideAuthorization, listAuthorizedApps, revokeAuthorizedApp } from './mcp-oauth'

const down = () => apiRequest.mockImplementation(async () => { throw new Error('404') })

it('relays only the authorization request parameters', async () => {
  apiRequest.mockImplementation(async () => ({ ok: true, client_name: 'Claude' }))
  const params = { client_id: 'https://claude.ai/c', redirect_uri: 'https://claude.ai/cb', state: 's', next: '/evil', code_challenge: '' }
  expect(await checkAuthorization(params)).toEqual({ ok: true, client_name: 'Claude' })
  expect(apiRequest.mock.lastCall).toEqual(['GET', '/oauth/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=s'])
  await decideAuthorization(params, true)
  expect(apiRequest.mock.lastCall).toEqual(['POST', '/oauth/authorize', {
    params: { client_id: 'https://claude.ai/c', redirect_uri: 'https://claude.ai/cb', state: 's' }, approve: true,
  }])
})

it('the consent reads answer null when EERP is unreachable or OAuth is off', async () => {
  down()
  expect(await checkAuthorization({})).toBeNull()
  expect(await decideAuthorization({}, false)).toBeNull()
})

it('the app list is null and a revoke false when Go refuses', async () => {
  down()
  expect(await listAuthorizedApps()).toBeNull()
  expect(await revokeAuthorizedApp('a/b')).toBe(false)
  expect(apiRequest.mock.lastCall).toEqual(['DELETE', '/oauth/grants/a%2Fb'])
})

it('lists and revokes the caller’s apps', async () => {
  apiRequest.mockImplementation(async (method: string) => (method === 'GET' ? { data: [{ id: 'g1', client_name: 'Claude' }] } : undefined))
  expect(await listAuthorizedApps()).toEqual([{ id: 'g1', client_name: 'Claude' }])
  expect(await revokeAuthorizedApp('g1')).toBe(true)
})
