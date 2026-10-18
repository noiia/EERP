import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { setEntityStatusBarConfig } = vi.hoisted(() => ({
  setEntityStatusBarConfig: vi.fn<(...args: unknown[]) => Promise<{ ok: true } | { ok: false; message: string }>>(
    async () => ({ ok: true }),
  ),
}))
vi.mock('@/lib/status-bar-config', () => ({ setEntityStatusBarConfig }))

import StatusBarSettings, { type StatusBarEntityRow } from './StatusBarSettings'

const row: StatusBarEntityRow = {
  entity: 'crm',
  moduleField: 'status',
  fields: [
    { name: 'status', label: 'Status', options: ['incoming', 'running', 'won'] },
    { name: 'stage', label: 'Stage', options: ['cold', 'hot'] },
  ],
  config: { field: null, steps: null },
}

beforeEach(() => setEntityStatusBarConfig.mockClear())

const checkbox = (label: string) => screen.getByRole('checkbox', { name: label }) as HTMLInputElement

it('starts on the module field with every value ticked, and saving that stores no override', async () => {
  render(<StatusBarSettings rows={[row]} canEdit />)
  expect(['incoming', 'running', 'won'].every((o) => checkbox(o).checked)).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(setEntityStatusBarConfig).toHaveBeenCalledWith('crm', { field: null, steps: null }))
  expect(screen.queryByRole('button', { name: 'Revert to module settings' })).toBeNull()
})

it('saves a subset of steps, in the field order', async () => {
  render(<StatusBarSettings rows={[row]} canEdit />)
  fireEvent.click(checkbox('running'))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(setEntityStatusBarConfig).toHaveBeenCalledWith('crm', { field: null, steps: ['incoming', 'won'] }),
  )
  expect(await screen.findByRole('button', { name: 'Revert to module settings' })).toBeTruthy()
})

it('switching field lists that field values, and revert goes back to the module default', async () => {
  render(<StatusBarSettings rows={[row]} canEdit />)
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Field' }))
  fireEvent.click(within(screen.getByRole('listbox')).getByText('Stage'))
  expect(checkbox('cold').checked && checkbox('hot').checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(setEntityStatusBarConfig).toHaveBeenCalledWith('crm', { field: 'stage', steps: null }))
  fireEvent.click(await screen.findByRole('button', { name: 'Revert to module settings' }))
  await waitFor(() => expect(setEntityStatusBarConfig).toHaveBeenLastCalledWith('crm', { field: null, steps: null }))
  expect(checkbox('incoming').checked).toBe(true)
})

it('shows a saved override', () => {
  render(<StatusBarSettings rows={[{ ...row, config: { field: null, steps: ['won'] } }]} canEdit />)
  expect(checkbox('won').checked).toBe(true)
  expect(checkbox('incoming').checked).toBe(false)
})

it('refuses to save with no step, and is read-only without the permission', () => {
  const { unmount } = render(<StatusBarSettings rows={[row]} canEdit />)
  for (const o of ['incoming', 'running', 'won']) fireEvent.click(checkbox(o))
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  unmount()
  render(<StatusBarSettings rows={[row]} canEdit={false} />)
  expect(checkbox('won').disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
})

it("shows Go's refusal", async () => {
  setEntityStatusBarConfig.mockResolvedValueOnce({ ok: false, message: 'step "won" is listed twice' })
  render(<StatusBarSettings rows={[row]} canEdit />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('step "won" is listed twice')).toBeTruthy()
})
