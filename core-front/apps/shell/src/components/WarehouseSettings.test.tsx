import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { saveWarehouseSettings } = vi.hoisted(() => ({
  saveWarehouseSettings: vi.fn<(...args: unknown[]) => Promise<{ ok: true } | { ok: false; message: string }>>(
    async () => ({ ok: true }),
  ),
}))
vi.mock('@/lib/warehouse-settings', () => ({ saveWarehouseSettings }))

import WarehouseSettings from './WarehouseSettings'

const toggle = () => screen.getByLabelText('Generate references automatically') as HTMLInputElement

it('turns automatic references off and saves it', async () => {
  render(<WarehouseSettings initial={{ auto_reference: true }} canEdit />)
  expect(toggle().checked).toBe(true)
  fireEvent.click(toggle())
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saveWarehouseSettings).toHaveBeenCalledWith({ auto_reference: false }))
  expect(await screen.findByText('Saved.')).toBeTruthy()
})

it("shows Go's refusal", async () => {
  saveWarehouseSettings.mockResolvedValueOnce({ ok: false, message: 'auto_reference (true or false) is required.' })
  render(<WarehouseSettings initial={{ auto_reference: false }} canEdit />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('auto_reference (true or false) is required.')).toBeTruthy()
})

it('is read-only without the write permission', () => {
  render(<WarehouseSettings initial={{ auto_reference: true }} canEdit={false} />)
  expect(toggle().disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
})
