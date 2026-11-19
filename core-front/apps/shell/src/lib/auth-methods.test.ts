// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./bff', () => ({ forwardedFor: async () => ({}) }))

import { getLoginMethods } from './auth-methods'

const LOCAL = { default: { id: 'local', kind: 'password', label: '' }, alternatives: [] }

beforeEach(() => {
  process.env.API_BASE = 'http://api.test'
})
afterEach(() => vi.unstubAllGlobals())

describe('getLoginMethods', () => {
  it('returns what Go answers', async () => {
    const body = {
      default: { id: 'ldap', kind: 'password', label: 'Corp' },
      alternatives: [{ id: 'oidc:corp', kind: 'redirect', label: 'SSO' }],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body))),
    )
    expect(await getLoginMethods()).toEqual(body)
  })

  it('falls back to local on a Go 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )
    expect(await getLoginMethods()).toEqual(LOCAL)
  })

  it('falls back to local on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down')
      }),
    )
    expect(await getLoginMethods()).toEqual(LOCAL)
  })
})
