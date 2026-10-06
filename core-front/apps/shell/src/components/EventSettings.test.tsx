import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { saveEventSettings } = vi.hoisted(() => ({
  saveEventSettings: vi.fn<(...args: unknown[]) => Promise<{ ok: true } | { ok: false; message: string }>>(async () => ({ ok: true })),
}))
vi.mock('@/lib/event-settings', () => ({ saveEventSettings }))

import EventSettings from './EventSettings'

it('saves the reminder delay and the claim window', async () => {
  render(<EventSettings initial={{ reminder_hours: 24, waitlist_claim_hours: 12 }} canEdit />)
  fireEvent.change(screen.getByLabelText(/reminder/i), { target: { value: '48' } })
  fireEvent.change(screen.getByLabelText(/waiting list/i), { target: { value: '6' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saveEventSettings).toHaveBeenCalledWith({ reminder_hours: 48, waitlist_claim_hours: 6 }))
  expect(await screen.findByText('Saved.')).toBeTruthy()
})

it("shows Go's refusal", async () => {
  saveEventSettings.mockResolvedValueOnce({ ok: false, message: 'reminder_hours must be 0 to 720' })
  render(<EventSettings initial={{ reminder_hours: 24, waitlist_claim_hours: 12 }} canEdit />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('reminder_hours must be 0 to 720')).toBeTruthy()
})

it('is read-only without the write permission', () => {
  render(<EventSettings initial={{ reminder_hours: 24, waitlist_claim_hours: 12 }} canEdit={false} />)
  expect((screen.getByLabelText(/reminder/i) as HTMLInputElement).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
})
