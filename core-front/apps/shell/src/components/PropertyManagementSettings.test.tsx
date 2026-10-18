import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { savePropertyManagementSettings } = vi.hoisted(() => ({
  savePropertyManagementSettings: vi.fn<(...args: unknown[]) => Promise<{ ok: true } | { ok: false; message: string }>>(
    async () => ({ ok: true }),
  ),
}))
vi.mock('@/lib/propertymanagement-settings', () => ({ savePropertyManagementSettings }))

import PropertyManagementSettings from './PropertyManagementSettings'

it('turns "Display taxes on report" on and saves it', async () => {
  render(<PropertyManagementSettings initial={{ display_taxes_on_report: false }} canEdit />)
  const toggle = screen.getByLabelText('Display taxes on report') as HTMLInputElement
  expect(toggle.checked).toBe(false)
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(savePropertyManagementSettings).toHaveBeenCalledWith({ display_taxes_on_report: true }))
  expect(await screen.findByText('Saved.')).toBeTruthy()
})

it("shows Go's refusal", async () => {
  savePropertyManagementSettings.mockResolvedValueOnce({ ok: false, message: 'malformed body' })
  render(<PropertyManagementSettings initial={{ display_taxes_on_report: true }} canEdit />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('malformed body')).toBeTruthy()
})

it('is read-only without the write permission', () => {
  render(<PropertyManagementSettings initial={{ display_taxes_on_report: true }} canEdit={false} />)
  expect((screen.getByLabelText('Display taxes on report') as HTMLInputElement).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
})
