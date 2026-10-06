import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => Promise<unknown>) => fn, revalidateTag: vi.fn() }))

import { BlockView } from './BlockView'
import type { Block, PublicDataSource } from '../types'

afterEach(() => vi.unstubAllGlobals())

const noSource: PublicDataSource = { list: async () => null, get: async () => null }

const upcoming = [
  { id: 'e1', name: 'Pottery class', kind: 'sessions', timezone: 'Europe/Paris', location: 'Studio', picture: true, next_session_at: '2026-10-05T07:00:00Z', seats_left: 3 },
  { id: 'e2', name: 'Full workshop', kind: 'sessions', timezone: 'Europe/Paris', next_session_at: '2026-10-06T07:00:00Z', seats_left: 0 },
  { id: 'e3', name: 'Consultation', kind: 'appointment', timezone: 'Europe/Paris', next_session_at: null, seats_left: null },
]

function stubUpcoming(status = 200) {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: upcoming }), { status }))
  vi.stubGlobal('fetch', fetchMock)
  process.env.API_BASE = 'http://api.test'
  return fetchMock
}

const block = (config: Record<string, unknown>): Block => ({ id: 'b', type: 'event_list', x: 0, y: 0, w: 36, h: 18, config })

describe('event_list block', () => {
  it('lists upcoming events as cards linking to the event page', async () => {
    const fetchMock = stubUpcoming()
    render(await BlockView({ block: block({ display: 'cards', limit: 6, detail_slug: 'events' }), source: noSource, params: {} }))
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://api.test/api/v1/public/events/upcoming?limit=6')
    const pottery = screen.getByText('Pottery class').closest('a')!
    expect(pottery.getAttribute('href')).toBe('/events/e1')
    expect(within(pottery).getByText(/3 seats left/i)).toBeTruthy()
    expect(within(pottery).getByText('Studio')).toBeTruthy()
    expect(pottery.querySelector('img')?.getAttribute('src')).toBe('/api/v1/public/event/e1/picture/picture')
    expect(within(screen.getByText('Full workshop').closest('a')!).getByText(/— Full$/)).toBeTruthy()
    expect(within(screen.getByText('Consultation').closest('a')!).getByText(/book a slot/i)).toBeTruthy()
  })

  it('renders a list without links when no event page is set', async () => {
    stubUpcoming()
    render(await BlockView({ block: block({ display: 'list' }), source: noSource, params: {} }))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText('Pottery class').closest('a')).toBeNull()
  })

  it('renders nothing while events are unpublished', async () => {
    stubUpcoming(404)
    const { container } = render(<>{await BlockView({ block: block({}), source: noSource, params: {} })}</>)
    expect(container.textContent).toBe('')
  })
})

describe('booking blocks on a generic event page', () => {
  it('book the event in the URL when no event is set', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    process.env.API_BASE = 'http://api.test'
    const get = vi.fn(async (_t: string, id: string) => ({ id, name: 'From URL', kind: 'sessions', timezone: 'Europe/Paris' }))
    render(await BlockView({ block: { id: 'b', type: 'event_booking', x: 0, y: 0, w: 36, h: 18, config: {} }, source: { list: async () => null, get }, params: { id: 'e9' } }))
    expect(get).toHaveBeenCalledWith('event', 'e9')
    expect(screen.getByRole('heading', { name: 'From URL' })).toBeTruthy()
  })

  it('a block of the other kind renders nothing for that event', async () => {
    const get = async (_t: string, id: string) => ({ id, name: 'Sessions event', kind: 'sessions' })
    const { container } = render(<>{await BlockView({ block: { id: 'b', type: 'appointment_booking', x: 0, y: 0, w: 36, h: 18, config: {} }, source: { list: async () => null, get }, params: { id: 'e9' } })}</>)
    expect(container.textContent).toBe('')
  })
})
