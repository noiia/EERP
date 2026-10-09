import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const ws = vi.hoisted(() => ({
  savePublished: vi.fn(),
  updateWebsiteUser: vi.fn(),
  listOutbox: vi.fn(),
  retryOutbox: vi.fn(),
}))
vi.mock('@/lib/website-settings', () => ws)

import PublishedDataForm from './published/PublishedDataForm'
import WebsiteUsersTable from './users/WebsiteUsersTable'
import OutboxTable from './outbox/OutboxTable'

beforeEach(() => Object.values(ws).forEach((m) => m.mockReset()))

describe('PublishedDataForm', () => {
  it('says so when nothing is declared', () => {
    render(<PublishedDataForm tables={[]} />)
    expect(screen.getByText('No table is declared for publication.')).toBeTruthy()
  })

  it('saves the toggled fields and the non-empty filters', async () => {
    ws.savePublished.mockResolvedValue({ ok: true })
    render(<PublishedDataForm tables={[{ table: 'product', declared: ['name', 'price'], fields: ['name'], filter: { published: 'true' } }]} />)
    fireEvent.click(screen.getByLabelText('name')) // off
    fireEvent.click(screen.getByLabelText('price')) // on
    fireEvent.change(screen.getAllByLabelText('Value')[0], { target: { value: 'yes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fireEvent.change(screen.getAllByLabelText('Column')[1], { target: { value: 'kind' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove filter' })[2])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(ws.savePublished).toHaveBeenCalledWith('product', { fields: ['price'], filter: { published: 'yes', kind: '' } })
  })

  it("shows Go's message or the fallback on failure", async () => {
    ws.savePublished.mockResolvedValueOnce({ ok: false, message: 'forbidden' }).mockResolvedValueOnce({ ok: false, message: '' })
    render(<PublishedDataForm tables={[{ table: 'event', declared: [], fields: [], filter: undefined as unknown as Record<string, string> }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('forbidden')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Could not save.')).toBeTruthy()
  })
})

const user = { id: 'u1', email: 'v@x.io', name: 'Vi', surname: '', phone: '', created_at: '2026-01-01T00:00:00Z', disabled: false, email_verified: true }

describe('WebsiteUsersTable', () => {
  it('saves name and phone on blur and toggles disabled', async () => {
    ws.updateWebsiteUser.mockResolvedValue({ ok: true })
    render(<WebsiteUsersTable initial={[user, { ...user, id: 'u2', email: 'w@x.io', email_verified: false }]} />)
    expect(screen.getByText('No')).toBeTruthy()
    const row = screen.getByText('v@x.io').closest('tr')!
    const [name, phone] = within(row).getAllByRole('textbox')
    fireEvent.change(name, { target: { value: 'Ada' } })
    fireEvent.blur(name)
    fireEvent.change(phone, { target: { value: '06' } })
    fireEvent.blur(phone)
    fireEvent.click(within(row).getByLabelText('Disabled'))
    await waitFor(() => expect(ws.updateWebsiteUser).toHaveBeenCalledTimes(3))
    expect(ws.updateWebsiteUser.mock.calls).toEqual([['u1', { name: 'Ada' }], ['u1', { phone: '06' }], ['u1', { disabled: true }]])
    await waitFor(() => expect((within(row).getByLabelText('Disabled') as HTMLInputElement).checked).toBe(true))
  })

  it('shows an error when a save fails', async () => {
    ws.updateWebsiteUser.mockResolvedValueOnce({ ok: false, message: '' })
    render(<WebsiteUsersTable initial={[user]} />)
    fireEvent.click(screen.getByLabelText('Disabled'))
    expect(await screen.findByText('Could not save.')).toBeTruthy()
  })
})

const mail = { id: 'm1', to_address: 'a@x.io', subject: 'Hi', status: 'failed' as const, attempts: 5, next_attempt_at: '', last_error: 'relay down', sent_at: null, created_at: '2026-01-01T00:00:00Z' }

describe('OutboxTable', () => {
  it('retries a failed mail and reloads', async () => {
    ws.retryOutbox.mockResolvedValueOnce({ ok: true })
    ws.listOutbox.mockResolvedValue([{ ...mail, status: 'pending' }])
    render(<OutboxTable initial={[mail]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull())
    expect(ws.retryOutbox).toHaveBeenCalledWith('m1')
    expect(ws.listOutbox).toHaveBeenCalledWith(undefined)
  })

  it('shows a retry error', async () => {
    ws.retryOutbox.mockResolvedValueOnce({ ok: false, message: '' })
    ws.listOutbox.mockResolvedValue([mail])
    render(<OutboxTable initial={[mail]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Could not retry.')).toBeTruthy()
  })

  it('filters by status', async () => {
    ws.listOutbox.mockResolvedValue([])
    render(<OutboxTable initial={[mail]} />)
    fireEvent.mouseDown(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'sent' }))
    await waitFor(() => expect(ws.listOutbox).toHaveBeenCalledWith('sent'))
    await waitFor(() => expect(screen.queryByText('a@x.io')).toBeNull())
  })
})
