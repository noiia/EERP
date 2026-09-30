import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => Promise<unknown>) => fn, revalidateTag: vi.fn() }))

import { BookingForm, formatChoice } from './BookingForm'
import { BlockView } from './BlockView'
import type { PublicDataSource } from '../types'

afterEach(() => vi.unstubAllGlobals())

const start = '2026-10-05T07:00:00Z' // 09:00 in Paris
const label = formatChoice(start, 'Europe/Paris', null)

function fill() {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'v@x.io' } })
  fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Vi' } })
}

describe('BookingForm', () => {
  it('labels times in the event time zone', () => {
    expect(label).toMatch(/9:00|09:00/)
  })

  it('posts the chosen session and shows the confirmation', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'b1', status: 'confirmed' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BookingForm eventId="e1" kind="session" timeZone="Europe/Paris" maxSeats={3} choices={[{ id: 's1', start, seatsLeft: 2 }]} />)
    fireEvent.click(screen.getByRole('radio'))
    fill()
    fireEvent.click(screen.getByRole('button', { name: /book/i }))
    await screen.findByText(/booking confirmed/i)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/site-booking')
    expect(JSON.parse(String((fetchMock.mock.calls[0][1]!).body))).toMatchObject({
      event_id: 'e1', session_id: 's1', seats: 1, email: 'v@x.io', name: 'Vi',
    })
  })

  it('a slot booking posts slot_start; a 409 says "just taken" and refetches', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'no seats left' } }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    const onTaken = vi.fn()
    render(<BookingForm eventId="e1" kind="slot" timeZone="Europe/Paris" choices={[{ id: start, start, seatsLeft: 1 }]} onTaken={onTaken} />)
    fireEvent.click(screen.getByRole('radio'))
    fill()
    fireEvent.click(screen.getByRole('button', { name: /book/i }))
    await screen.findByText(/just taken/i)
    expect(JSON.parse(String((fetchMock.mock.calls[0][1]!).body))).toMatchObject({ slot_start: start })
    expect(onTaken).toHaveBeenCalled()
  })

  it("a 400 shows Go's message", async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'seats must be between 1 and 10' } }), { status: 400 })))
    render(<BookingForm eventId="e1" kind="session" timeZone="Europe/Paris" choices={[{ id: 's1', start, seatsLeft: 2 }]} />)
    fireEvent.click(screen.getByRole('radio'))
    fill()
    fireEvent.click(screen.getByRole('button', { name: /book/i }))
    await screen.findByText('seats must be between 1 and 10')
  })

  it('seat count is capped by seats left and by the event maximum', () => {
    render(<BookingForm eventId="e1" kind="session" timeZone="Europe/Paris" maxSeats={3} choices={[{ id: 's1', start, seatsLeft: 2 }]} />)
    fireEvent.click(screen.getByRole('radio'))
    expect(Number((screen.getByLabelText(/seats/i) as HTMLInputElement).max)).toBe(2)
  })

  it('a full session is shown but not selectable', () => {
    render(<BookingForm eventId="e1" kind="session" timeZone="Europe/Paris" choices={[{ id: 's1', start, seatsLeft: 0 }]} />)
    expect((screen.getByRole('radio') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/full/i)).toBeTruthy()
  })
})

describe('event_booking block', () => {
  it('renders the published event and its sessions', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 's1', starts_at: start, seats_left: 4 }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    process.env.API_BASE = 'http://api.test'
    const source: PublicDataSource = {
      list: async () => null,
      get: async () => ({ id: 'e1', name: 'Pottery class', kind: 'sessions', timezone: 'Europe/Paris', location: 'Studio' }),
    }
    render(await BlockView({ block: { id: 'b', type: 'event_booking', x: 0, y: 0, w: 12, h: 4, config: { event_id: 'e1' } }, source, params: {} }))
    expect(screen.getByRole('heading', { name: 'Pottery class' })).toBeTruthy()
    expect(screen.getByRole('radio').closest('label')?.textContent?.replace(/\s/g, ' ')).toContain(label.replace(/\s/g, ' '))
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://api.test/api/v1/public/event/e1/sessions')
  })
})
