import { expect, it, vi } from 'vitest'

const requireAuth = vi.fn()
vi.mock('@/lib/session', () => ({ requireAuth: (p: string) => requireAuth(p) }))
const checkAuthorization = vi.fn<(params: unknown) => Promise<{ ok: boolean }>>(async () => ({ ok: true }))
vi.mock('@/lib/mcp-oauth', () => ({ checkAuthorization: (p: unknown) => checkAuthorization(p) }))
vi.mock('@/components/OAuthConsent', () => ({ default: () => null }))

import OAuthAuthorizePage from './page'

it('sends a signed-out user through login back to this exact request, then checks it', async () => {
  const el = await OAuthAuthorizePage({ searchParams: Promise.resolve({ client_id: 'https://claude.ai/c', state: 'a b', multi: ['x', 'y'] }) })
  expect(requireAuth).toHaveBeenCalledWith('/oauth/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fc&state=a+b')
  expect(checkAuthorization).toHaveBeenCalledWith({ client_id: 'https://claude.ai/c', state: 'a b' })
  expect(el.props).toEqual({ check: { ok: true }, params: { client_id: 'https://claude.ai/c', state: 'a b' } })
})
