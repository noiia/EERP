import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => Promise<unknown>) => fn, revalidateTag: vi.fn() }))
const identity = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/lib/site-session', () => ({ getSiteIdentity: async () => identity.value }))
vi.mock('../account', () => ({ getWebsiteMe: async () => ({ name: 'Vi', email: 'v@x.io' }), getMyContact: async () => null }))

import { BlockView } from './BlockView'
import type { PublicDataSource } from '../types'

process.env.API_BASE = 'http://api.test'
afterEach(() => { vi.unstubAllGlobals(); identity.value = null })

const source = (kind: string): PublicDataSource => ({
  list: async () => null,
  get: async () => ({ id: 'e1', name: 'Pottery class', kind, timezone: 'Europe/Paris' }),
})
const stubFetch = () => vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })))
const view = async (type: 'event_booking' | 'appointment_booking', config: Record<string, unknown>, kind: string, params: { id?: string; path?: string }) =>
  render(await BlockView({ block: { id: 'b', type, x: 0, y: 0, w: 12, h: 4, config }, source: source(kind), params }))

describe.each([['event_booking', 'sessions'], ['appointment_booking', 'appointment']] as const)('%s login_required', (type, kind) => {
  it('anonymous: a login gate back to the current page path, no form', async () => {
    stubFetch()
    await view(type, { event_id: 'e1', login_required: true }, kind, { path: '/events/e1' })
    expect(screen.getByRole('link', { name: /log in to continue/i }).getAttribute('href')).toBe('/login?next=%2Fevents%2Fe1')
    expect(screen.getByRole('link', { name: /sign up/i }).getAttribute('href')).toBe('/signup?next=%2Fevents%2Fe1')
    expect(screen.queryByRole('button', { name: /book/i })).toBeNull()
  })

  it('anonymous with an after-login page: next is that page', async () => {
    stubFetch()
    await view(type, { event_id: 'e1', login_required: true, after_login_slug: 'members' }, kind, { path: '/events/e1' })
    expect(screen.getByRole('link', { name: /log in to continue/i }).getAttribute('href')).toBe('/login?next=%2Fmembers')
  })

  it('signed in: the booking UI renders, prefilled', async () => {
    stubFetch()
    identity.value = { userId: 'u' }
    await view(type, { event_id: 'e1', login_required: true }, kind, { path: '/events/e1' })
    expect(screen.queryByRole('link', { name: /log in to continue/i })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Pottery class' })).toBeTruthy()
  })

  it('not required: anonymous still sees the booking UI', async () => {
    stubFetch()
    await view(type, { event_id: 'e1' }, kind, { path: '/events/e1' })
    expect(screen.queryByRole('link', { name: /log in to continue/i })).toBeNull()
  })
})
