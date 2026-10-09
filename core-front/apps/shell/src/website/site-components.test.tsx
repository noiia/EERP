import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
const saveProfile = vi.hoisted(() => vi.fn())
vi.mock('./account-actions', () => ({ saveProfile }))
const fetchSlots = vi.hoisted(() => vi.fn())
vi.mock('./booking-actions', () => ({ fetchSlots }))
vi.mock('./blocks/BookingForm', () => ({
  BookingForm: ({ choices, onTaken }: { choices: { id: string }[]; onTaken: () => void }) => (
    <button onClick={onTaken}>{`slots:${choices.map((c) => c.id).join(',')}`}</button>
  ),
}))

import { LogoutButton, ProfileForm } from './AccountForm'
import { SiteHeader } from './SiteHeader'
import { SlotPicker } from './blocks/SlotPicker'

beforeEach(() => {
  router.push.mockReset()
  router.refresh.mockReset()
  saveProfile.mockReset()
  fetchSlots.mockReset()
  vi.unstubAllGlobals()
})

describe('SiteHeader', () => {
  it('links menu pages and the account/ERP entries', () => {
    render(<SiteHeader menu={[{ slug: '', title: 'Home' }, { slug: 'shop', title: 'Shop' }]} signedIn staff />)
    expect(screen.getAllByRole('link', { name: 'Shop' })[0].getAttribute('href')).toBe('/shop')
    expect(screen.getByRole('link', { name: 'My account' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'ERP' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Home' }))
  })

  it('offers log in to a visitor', () => {
    render(<SiteHeader menu={[]} signedIn={false} staff={false} />)
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/login')
    expect(screen.queryByRole('link', { name: 'ERP' })).toBeNull()
  })
})

describe('AccountForm', () => {
  it('shows the save outcome', async () => {
    saveProfile.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'invalid' })
    render(<ProfileForm me={{ email: 'v@x.io', name: 'Vi', surname: '', phone: '', email_verified: true }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Name is required/)).toBeTruthy()
  })

  it('logs out and goes home even when the call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    render(<LogoutButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/'))
    expect(router.refresh).toHaveBeenCalled()
  })
})

describe('SlotPicker', () => {
  it('loads a week of slots, pages weeks and refetches after a taken slot', async () => {
    fetchSlots.mockResolvedValueOnce([{ start: 's1', end: 'e1', seats_left: 1 }]).mockResolvedValue(null)
    render(<SlotPicker eventId="e1" timeZone="Europe/Paris" />)
    expect(await screen.findByText('slots:s1')).toBeTruthy()
    const [from, to] = fetchSlots.mock.calls[0].slice(1) as [string, string]
    expect(Date.parse(to) - Date.parse(from)).toBe(7 * 86400_000)
    expect((screen.getByRole('button', { name: 'Previous week' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    expect(await screen.findByText('slots:')).toBeTruthy()
    expect(fetchSlots).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    await waitFor(() => expect(fetchSlots).toHaveBeenCalledTimes(3))
    await act(async () => { fireEvent.click(await screen.findByText('slots:')) })
    await waitFor(() => expect(fetchSlots).toHaveBeenCalledTimes(4))
  })
})
