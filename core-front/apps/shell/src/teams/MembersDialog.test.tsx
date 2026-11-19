import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const addMember = vi.fn()
const setMemberRole = vi.fn()
const removeMember = vi.fn()
vi.mock('./client', () => ({
  directory: () => Promise.resolve([
    { id: 'u1', display_name: 'Alice', email: 'a@x' },
    { id: 'u2', display_name: 'Bob', email: 'b@x' },
  ]),
  addMember: (...a: unknown[]) => addMember(...a),
  setMemberRole: (...a: unknown[]) => setMemberRole(...a),
  removeMember: (...a: unknown[]) => removeMember(...a),
}))

import { MembersDialog } from './MembersDialog'

const members = [{ user_id: 'u1', display_name: 'Alice', email: 'a@x', role: 'owner' as const }]

describe('MembersDialog', () => {
  const onChanged = vi.fn()
  beforeEach(() => {
    for (const f of [addMember, setMemberRole, removeMember, onChanged]) f.mockReset().mockResolvedValue(undefined)
  })
  const open = () => render(<MembersDialog open teamId="t1" members={members} onClose={vi.fn()} onChanged={onChanged} />)

  it('adds a directory user who is not a member yet', async () => {
    open()
    const input = screen.getByRole('combobox', { name: /add a person/i })
    fireEvent.mouseDown(input)
    fireEvent.change(input, { target: { value: 'b' } })
    fireEvent.click(await screen.findByRole('option', { name: /Bob/ }))
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await waitFor(() => expect(addMember).toHaveBeenCalledWith('t1', 'u2', 'member'))
    expect(onChanged).toHaveBeenCalled()
  })

  it('changes a role and removes a member', async () => {
    open()
    const row = screen.getByRole('listitem', { name: 'Alice' })
    fireEvent.change(within(row).getByRole('combobox', { hidden: true, name: /role/i }), { target: { value: 'guest' } })
    await waitFor(() => expect(setMemberRole).toHaveBeenCalledWith('t1', 'u1', 'guest'))
    fireEvent.click(within(row).getByRole('button', { name: /remove/i }))
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith('t1', 'u1'))
  })
})
