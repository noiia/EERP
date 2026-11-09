import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const getAccess = vi.fn()
const setAccess = vi.fn()
vi.mock('./client', () => ({
  getAccess: (...a: unknown[]) => getAccess(...a),
  setAccess: (...a: unknown[]) => setAccess(...a),
  listGroups: () => Promise.resolve([{ id: 'g1', name: 'Sales', user_ids: [] }]),
}))

import { AccessDialog } from './AccessDialog'

const members = [
  { user_id: 'u1', display_name: 'Alice', email: 'a@x', role: 'owner' as const },
  { user_id: 'u2', display_name: 'Bob', email: 'b@x', role: 'member' as const },
]
const channel = (over: object = {}) => ({ id: 'c1', team_id: 't1', kind: 'channel', name: 'general', unread: 0, ...over })

describe('AccessDialog', () => {
  const onSaved = vi.fn()
  beforeEach(() => {
    onSaved.mockReset()
    getAccess.mockReset().mockResolvedValue({ user_ids: ['u2'], group_ids: ['g1'] })
    setAccess.mockReset().mockResolvedValue({ user_ids: [], group_ids: [] })
  })
  const open = (ch = channel()) => render(<AccessDialog open teamId="t1" channel={ch} members={members} onClose={vi.fn()} onSaved={onSaved} />)

  it('preselects the stored people and groups', async () => {
    open()
    expect(await screen.findByText('Bob')).toBeInTheDocument()
    expect(screen.getByText('Sales')).toBeInTheDocument()
    expect(getAccess).toHaveBeenCalledWith('t1', 'c1')
  })

  it('saves the picked ids and reloads', async () => {
    open()
    await screen.findByText('Bob')
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'People' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Alice' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setAccess).toHaveBeenCalledWith('t1', 'c1', { user_ids: ['u2', 'u1'], group_ids: ['g1'] }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('says the conversation is open when nothing is picked', async () => {
    getAccess.mockResolvedValue({ user_ids: [], group_ids: [] })
    open()
    expect(await screen.findByText('Open to the whole team')).toBeInTheDocument()
  })

  it('says only owners see a private conversation with an empty list', async () => {
    getAccess.mockResolvedValue({ user_ids: [], group_ids: [] })
    open(channel({ private: true }))
    expect(await screen.findByText('Only owners can see this conversation.')).toBeInTheDocument()
    expect(screen.queryByText('Open to the whole team')).toBeNull()
  })

  it('shows Go’s message when the save is refused', async () => {
    setAccess.mockRejectedValue(new Error('user_ids and group_ids must belong to this team.'))
    open()
    await screen.findByText('Bob')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('user_ids and group_ids must belong to this team.')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })
})
