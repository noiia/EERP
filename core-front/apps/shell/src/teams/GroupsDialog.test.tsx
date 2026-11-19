import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const listGroups = vi.fn()
const createGroup = vi.fn()
const updateGroup = vi.fn()
const deleteGroup = vi.fn()
vi.mock('./client', () => ({
  listGroups: (...a: unknown[]) => listGroups(...a),
  createGroup: (...a: unknown[]) => createGroup(...a),
  updateGroup: (...a: unknown[]) => updateGroup(...a),
  deleteGroup: (...a: unknown[]) => deleteGroup(...a),
}))

import { GroupsDialog } from './GroupsDialog'

const members = [
  { user_id: 'u1', display_name: 'Alice', email: 'a@x', role: 'owner' as const },
  { user_id: 'u2', display_name: 'Bob', email: 'b@x', role: 'member' as const },
]

describe('GroupsDialog', () => {
  beforeEach(() => {
    listGroups.mockReset().mockResolvedValue([{ id: 'g1', name: 'Sales', user_ids: ['u1'] }])
    createGroup.mockReset().mockResolvedValue({ id: 'g2', name: 'Ops', user_ids: ['u2'] })
    updateGroup.mockReset().mockResolvedValue({})
    deleteGroup.mockReset().mockResolvedValue(undefined)
  })
  const open = () => render(<GroupsDialog open teamId="t1" members={members} onClose={vi.fn()} />)

  it('creates a group with members', async () => {
    open()
    await screen.findByDisplayValue('Sales')
    const form = screen.getByRole('group', { name: 'New group' })
    fireEvent.change(within(form).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Ops' } })
    fireEvent.mouseDown(within(form).getByRole('combobox', { name: 'Members' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Bob' }))
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(createGroup).toHaveBeenCalledWith('t1', { name: 'Ops', user_ids: ['u2'] }))
  })

  it('renames a group', async () => {
    open()
    const input = await screen.findByDisplayValue('Sales')
    fireEvent.change(input, { target: { value: 'Revenue' } })
    fireEvent.click(within(screen.getByRole('group', { name: 'Sales' })).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateGroup).toHaveBeenCalledWith('t1', 'g1', { name: 'Revenue', user_ids: ['u1'] }))
  })

  it('asks before deleting a group', async () => {
    open()
    await screen.findByDisplayValue('Sales')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(deleteGroup).not.toHaveBeenCalled()
    expect(await screen.findByText('Conversations that only this group could see will be visible to owners only.')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith('t1', 'g1'))
  })

  it('shows Go’s message when a save is refused', async () => {
    createGroup.mockRejectedValue(new Error('A group with this name already exists.'))
    open()
    await screen.findByDisplayValue('Sales')
    const form = screen.getByRole('group', { name: 'New group' })
    fireEvent.change(within(form).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Sales' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('A group with this name already exists.')).toBeInTheDocument()
  })
})
