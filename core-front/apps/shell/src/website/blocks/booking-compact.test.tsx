import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import { BookingForm } from './BookingForm'
import { sitePrefsStore } from '../site-prefs-store'

const start = '2026-10-05T07:00:00Z' // 09:00 in Paris
const reset = { base: '', rates: {}, currency: '', dateFormat: null }
afterEach(() => sitePrefsStore.set(reset))

describe('BookingForm compact (phone) label', () => {
  it('shows the short date pattern, the seats as an icon + count, without a dash', () => {
    sitePrefsStore.set({ base: 'EUR', rates: { EUR: 1 }, currency: 'EUR', dateFormat: 'dd/MM/yyyy' })
    render(<BookingForm eventId="e1" kind="session" timeZone="Europe/Paris" currency="EUR" choices={[{ id: 's1', start, seatsLeft: 4, price: 12 }]} />)
    const compact = screen.getByText('05/10/2026 09:00').parentElement!
    expect(compact.textContent).not.toContain('—')
    expect(compact.textContent).toContain('4')
    expect(compact.querySelector('svg')).not.toBeNull() // the seat icon
    expect(compact.textContent).toMatch(/€/)
  })

  it('converts the price to the visitor currency, marked approximate', () => {
    sitePrefsStore.set({ base: 'EUR', rates: { EUR: 1, USD: 1.5 }, currency: 'USD', dateFormat: 'dd/MM/yyyy' })
    render(<BookingForm eventId="e1" kind="session" timeZone="Europe/Paris" currency="EUR" choices={[{ id: 's1', start, seatsLeft: 4, price: 10 }]} />)
    const compact = screen.getByText('05/10/2026 09:00').parentElement!
    expect(compact.textContent).toMatch(/≈ .*15[.,]00/)
    expect(compact.textContent).toContain("$")
  })

  it('keeps the stored price when the visitor currency has no rate', () => {
    sitePrefsStore.set({ base: 'EUR', rates: { EUR: 1 }, currency: 'GBP', dateFormat: 'dd/MM/yyyy' })
    render(<BookingForm eventId="e1" kind="session" timeZone="Europe/Paris" currency="EUR" choices={[{ id: 's1', start, seatsLeft: 4, price: 10 }]} />)
    const compact = screen.getByText('05/10/2026 09:00').parentElement!
    expect(compact.textContent).not.toContain('≈')
    expect(compact.textContent).toMatch(/€/)
  })
})
