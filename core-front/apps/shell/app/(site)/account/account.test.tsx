import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
const actions = vi.hoisted(() => ({ cancelMyBooking: vi.fn(), resendVerification: vi.fn() }))
vi.mock('@/website/booking-actions', () => actions)
const getMyBookings = vi.hoisted(() => vi.fn())
vi.mock('@/website/account', () => ({ getMyBookings }))

import { CancelMyBookingButton, ResendVerificationButton, When } from './MyBookingsClient'
import { MyBookings } from './MyBookings'

beforeEach(() => {
  router.refresh.mockReset()
  actions.cancelMyBooking.mockReset()
  actions.resendVerification.mockReset()
})

describe('MyBookingsClient', () => {
  it('When renders a date, nothing without one', () => {
    const { container, rerender } = render(<When iso={null} />)
    expect(container.textContent).toBe('')
    rerender(<When iso="2026-10-05T07:00:00Z" />)
    expect(container.textContent).toMatch(/2026/)
  })

  it('cancel refreshes on success, offers a retry on failure', async () => {
    actions.cancelMyBooking.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { unmount } = render(<CancelMyBookingButton id="b1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(router.refresh).toHaveBeenCalled())
    unmount()
    render(<CancelMyBookingButton id="b1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: 'Could not cancel — retry' })).toBeTruthy()
  })

  it('resend reports the outcome', async () => {
    actions.resendVerification.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<ResendVerificationButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Resend the email' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Could not send — retry' }))
    expect(await screen.findByRole('button', { name: 'Email sent' })).toBeTruthy()
  })
})

describe('MyBookings', () => {
  it('splits upcoming from past and links the calendar of confirmed ones', async () => {
    const future = new Date(Date.now() + 86400_000).toISOString()
    getMyBookings.mockResolvedValue([
      { id: 'b1', event_id: 'e', event_name: 'Yoga', start: future, end: null, seats: 1, status: 'confirmed' },
      { id: 'b2', event_id: 'e', event_name: 'Pottery', start: future, end: null, seats: 2, status: 'waitlisted' },
      { id: 'b3', event_id: 'e', event_name: 'Old', start: '2020-01-01T00:00:00Z', end: null, seats: 1, status: 'attended' },
    ])
    render(await MyBookings({ verified: false }))
    expect(screen.getByText('Upcoming')).toBeTruthy()
    expect(screen.getByText('Past and cancelled')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Add to calendar' }).getAttribute('href')).toBe('/api/site-booking/b1/calendar')
    expect(screen.getByText('Confirm your email to see bookings made before you signed up.')).toBeTruthy()
  })

  it('shows the empty state without a session', async () => {
    getMyBookings.mockResolvedValue(null)
    render(await MyBookings({ verified: true }))
    expect(screen.getByText('Your bookings will appear here.')).toBeTruthy()
  })
})
