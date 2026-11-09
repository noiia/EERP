import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, prefetch: vi.fn() }) }))
const listFiles = vi.fn<(team: string, folder?: string) => Promise<unknown>>(() => Promise.reject(Object.assign(new Error(''), { status: 404 })))
const createChannel = vi.fn()
const openDirect = vi.fn()
const orderChannels = vi.fn()
const orderDirect = vi.fn()
const m = { updateTeam: vi.fn(), deleteTeam: vi.fn(), removeMember: vi.fn(), renameChannel: vi.fn(), deleteChannel: vi.fn() }
vi.mock('./client', () => ({
  updateTeam: (...a: unknown[]) => m.updateTeam(...a),
  deleteTeam: (...a: unknown[]) => m.deleteTeam(...a),
  removeMember: (...a: unknown[]) => m.removeMember(...a),
  renameChannel: (...a: unknown[]) => m.renameChannel(...a),
  deleteChannel: (...a: unknown[]) => m.deleteChannel(...a),
  listFiles: (t: string, f?: string) => listFiles(t, f),
  directory: () => Promise.resolve([{ id: 'u2', display_name: 'Bob', email: 'b@x' }]),
  createChannel: (...a: unknown[]) => createChannel(...a),
  openDirect: (...a: unknown[]) => openDirect(...a),
  orderChannels: (...a: unknown[]) => orderChannels(...a),
  orderDirect: (...a: unknown[]) => orderDirect(...a),
}))

import { useBreadcrumbStore, useSessionStore } from '@eerp/core-front'
import { Sidebar } from './Sidebar'
import type { Role } from './client'

const props = (role: Role) => ({
  teamId: 't1',
  team: { id: 't1', name: 'Sales', description: 'desk', role, member_count: 1, unread: 0 },
  role,
  members: [{ user_id: 'u1', display_name: 'Alice', email: 'a@x', role: 'owner' as Role }],
  channels: [
    { id: 'c1', team_id: 't1', kind: 'channel', name: 'general', unread: 0 },
    { id: 'c2', team_id: 't1', kind: 'channel', name: 'random', unread: 0 },
  ],
  directs: [],
  unread: { c2: 5 },
  view: { kind: 'channel' as const, id: 'c1' },
  onChanged: vi.fn(),
})

describe('Sidebar', () => {
  it('shows the add-channel and manage-members buttons only to owners', () => {
    const { rerender } = render(<Sidebar {...props('owner')} />)
    expect(screen.getByRole('button', { name: /add channel/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /manage members/i })).toBeInTheDocument()
    rerender(<Sidebar {...props('member')} />)
    expect(screen.queryByRole('button', { name: /add channel/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /manage members/i })).toBeNull()
  })

  it('shows the unread badge of a channel', () => {
    render(<Sidebar {...props('member')} />)
    expect(screen.getByRole('link', { name: /random/ })).toHaveTextContent('5')
    expect(screen.getByRole('link', { name: /general/ })).not.toHaveTextContent(/\d/)
  })

  it('shows a member photo and a direct chat photo', () => {
    const p = props('member')
    const { container } = render(
      <Sidebar
        {...p}
        members={[{ user_id: 'u1', display_name: 'Alice', email: 'a@x', role: 'owner' as Role, has_avatar: true }]}
        directs={[{ id: 'd1', other_user: { id: 'u2', display_name: 'Bob', email: 'b@x', has_avatar: true }, unread: 0, last_message_at: null }]}
      />,
    )
    const srcs = Array.from(container.querySelectorAll('img')).map((i) => i.getAttribute('src'))
    expect(srcs).toEqual(['/api/avatars/u1', '/api/avatars/u2'])
  })

  it('lists members and links Shares', () => {
    render(<Sidebar {...props('member')} />)
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /shares/i })).toHaveAttribute('href', '/app/teams/shared')
  })
})

describe('Sidebar actions', () => {
  it('creates a channel and opens it', async () => {
    createChannel.mockResolvedValue({ id: 'c9' })
    const p = props('owner')
    render(<Sidebar {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /add channel/i }))
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: ' dev ' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/teams/t1/channels/c9'))
    expect(createChannel).toHaveBeenCalledWith('t1', 'dev')
    expect(p.onChanged).toHaveBeenCalled()
  })

  it('opens a direct conversation picked from the directory', async () => {
    openDirect.mockResolvedValue({ id: 'd1' })
    render(<Sidebar {...props('member')} />)
    fireEvent.click(screen.getByRole('button', { name: /new conversation/i }))
    const input = screen.getByRole('combobox', { name: /person/i })
    fireEvent.mouseDown(input)
    fireEvent.change(input, { target: { value: 'b' } })
    fireEvent.click(await screen.findByRole('option', { name: /Bob/ }))
    fireEvent.click(screen.getByRole('button', { name: /^start$/i }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/teams/direct/d1'))
    expect(openDirect).toHaveBeenCalledWith('u2')
  })

  it('lists root folders and expands one lazily', async () => {
    listFiles.mockImplementation((_t, folder) => Promise.resolve({
      folders: folder ? [{ id: 'f2', name: 'Drafts', parent_id: 'f1', created_by: 'u1' }] : [{ id: 'f1', name: 'Docs', parent_id: null, created_by: 'u1' }],
    }))
    render(<Sidebar {...props('member')} />)
    expect(await screen.findByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/app/teams/t1/files?folder=f1')
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(await screen.findByRole('link', { name: 'Drafts' })).toHaveAttribute('href', '/app/teams/t1/files?folder=f2')
    expect(listFiles).toHaveBeenCalledWith('t1', 'f1')
  })

  it('opens the members dialog for an owner', async () => {
    render(<Sidebar {...props('owner')} />)
    fireEvent.click(screen.getByRole('button', { name: /manage members/i }))
    expect(await screen.findByRole('dialog', { name: /manage members/i })).toBeInTheDocument()
  })

  it('shows why a channel could not be created and keeps the dialog open', async () => {
    createChannel.mockRejectedValue(new Error('Name taken'))
    render(<Sidebar {...props('owner')} />)
    fireEvent.click(screen.getByRole('button', { name: /add channel/i }))
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'dev' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Name taken')
    expect(screen.getByRole('dialog', { name: /new channel/i })).toBeInTheDocument()
  })

  it('shows why a conversation could not be opened', async () => {
    openDirect.mockRejectedValue(new Error('Unknown user'))
    render(<Sidebar {...props('member')} />)
    fireEvent.click(screen.getByRole('button', { name: /new conversation/i }))
    const input = screen.getByRole('combobox', { name: /person/i })
    fireEvent.mouseDown(input)
    fireEvent.change(input, { target: { value: 'b' } })
    fireEvent.click(await screen.findByRole('option', { name: /Bob/ }))
    fireEvent.click(screen.getByRole('button', { name: /^start$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown user')
  })
})

describe('Sidebar team management', () => {
  beforeEach(() => {
    for (const f of Object.values(m)) f.mockReset().mockResolvedValue(undefined)
    push.mockReset()
    useSessionStore.setState({ identity: { userId: 'me' } } as never)
  })
  const menu = async (button: RegExp) => {
    fireEvent.click(screen.getByRole('button', { name: button }))
    return screen.findByRole('menu')
  }

  it('offers rename/delete and channel menus to owners, only leave to others', async () => {
    const { unmount } = render(<Sidebar {...props('owner')} />)
    expect(screen.getAllByRole('button', { name: /channel options/i })).toHaveLength(2)
    let list = await menu(/team options/i)
    expect(within(list).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Rename team', 'Delete team', 'Leave team'])
    unmount()
    render(<Sidebar {...props('member')} />)
    expect(screen.queryByRole('button', { name: /channel options/i })).toBeNull()
    list = await menu(/team options/i)
    expect(within(list).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Leave team'])
  })

  it('renames the team, keeping its description', async () => {
    const p = props('owner')
    render(<Sidebar {...p} />)
    fireEvent.click(within(await menu(/team options/i)).getByText('Rename team'))
    const dialog = await screen.findByRole('dialog', { name: 'Rename team' })
    fireEvent.change(within(dialog).getByLabelText(/name/i), { target: { value: ' Ops ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.updateTeam).toHaveBeenCalledWith('t1', 'Ops', 'desk'))
    expect(p.onChanged).toHaveBeenCalled()
  })

  it('shows Go\'s refusal when the last owner tries to leave', async () => {
    m.removeMember.mockRejectedValue(Object.assign(new Error('A team needs at least one owner.'), { status: 409, code: 'LAST_OWNER' }))
    render(<Sidebar {...props('owner')} />)
    fireEvent.click(within(await menu(/team options/i)).getByText('Leave team'))
    const dialog = await screen.findByRole('dialog', { name: 'Leave team' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A team needs at least one owner.')
    expect(m.removeMember).toHaveBeenCalledWith('t1', 'me')
    expect(push).not.toHaveBeenCalled()
  })

  it('leaves the team and goes back to the dashboard', async () => {
    render(<Sidebar {...props('member')} />)
    fireEvent.click(within(await menu(/team options/i)).getByText('Leave team'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/teams'))
  })

  it('deletes the team after confirmation and goes back to the dashboard', async () => {
    render(<Sidebar {...props('owner')} />)
    fireEvent.click(within(await menu(/team options/i)).getByText('Delete team'))
    expect(m.deleteTeam).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete team' })).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/teams'))
    expect(m.deleteTeam).toHaveBeenCalledWith('t1')
  })

  it('renames a channel and shows the last-channel refusal on delete', async () => {
    m.deleteChannel.mockRejectedValue(Object.assign(new Error('A team needs at least one channel.'), { status: 409, code: 'LAST_CHANNEL' }))
    const p = props('owner')
    render(<Sidebar {...p} />)
    fireEvent.click(within(await menu(/channel options #random/i)).getByText('Rename channel'))
    let dialog = await screen.findByRole('dialog', { name: 'Rename channel' })
    fireEvent.change(within(dialog).getByLabelText(/name/i), { target: { value: 'misc' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.renameChannel).toHaveBeenCalledWith('t1', 'c2', 'misc'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(within(await menu(/channel options #general/i)).getByText('Delete channel'))
    dialog = await screen.findByRole('dialog', { name: 'Delete channel' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A team needs at least one channel.')
  })

  it('leaves the deleted open channel for the team page', async () => {
    render(<Sidebar {...props('owner')} />)
    fireEvent.click(within(await menu(/channel options #general/i)).getByText('Delete channel'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/teams/t1'))
    expect(m.deleteChannel).toHaveBeenCalledWith('t1', 'c1')
  })

  it('names a disabled member and reloads the folder tree when the files pane changes folders', async () => {
    listFiles.mockResolvedValue({ folders: [{ id: 'f1', name: 'Docs', parent_id: null, created_by: 'u1' }] })
    const p = { ...props('member'), members: [{ user_id: 'u9', display_name: '', email: '', role: 'member' as Role }] }
    const { rerender } = render(<Sidebar {...p} />)
    expect(screen.getByText('Disabled user')).toBeInTheDocument()
    await screen.findByRole('link', { name: 'Docs' })
    const before = listFiles.mock.calls.length
    listFiles.mockResolvedValue({ folders: [{ id: 'f1', name: 'Docs', parent_id: null, created_by: 'u1' }, { id: 'f3', name: 'Plans', parent_id: null, created_by: 'u1' }] })
    rerender(<Sidebar {...p} foldersRev={1} />)
    expect(await screen.findByRole('link', { name: 'Plans' })).toBeInTheDocument()
    expect(listFiles.mock.calls.length).toBe(before + 1)
  })

  describe('order and breadcrumb', () => {
    const names = () => screen.getAllByRole('link').map((l) => l.textContent).filter((x) => /# /.test(x ?? '')).map((x) => x!.replace(/\d+$/, ''))
    const directs = [
      { id: 'd1', other_user: { id: 'u2', display_name: 'Bob', email: 'b@x' }, unread: 0, last_message_at: null },
      { id: 'd2', other_user: { id: 'u3', display_name: 'Cy', email: 'c@x' }, unread: 0, last_message_at: null },
    ]
    beforeEach(() => { orderChannels.mockReset().mockResolvedValue(undefined); orderDirect.mockReset().mockResolvedValue(undefined) })

    it('resets the breadcrumb trail when a channel is clicked', () => {
      const reset = vi.spyOn(useBreadcrumbStore.getState(), 'reset')
      useBreadcrumbStore.setState({ reset })
      render(<Sidebar {...props('member')} />)
      fireEvent.click(screen.getByRole('link', { name: /random/ }))
      expect(reset).toHaveBeenCalled()
    })

    it('reorders channels on drop and saves the order', async () => {
      render(<Sidebar {...props('member')} />)
      const item = (n: RegExp) => screen.getByRole('link', { name: n }).closest('[draggable]')!
      fireEvent.dragStart(item(/random/))
      fireEvent.drop(item(/general/))
      expect(names()).toEqual(['# random', '# general'])
      expect(orderChannels).toHaveBeenCalledWith('t1', ['c2', 'c1'])
    })

    it('reverts and shows the error when the save is rejected', async () => {
      orderChannels.mockRejectedValue(new Error('not yours'))
      render(<Sidebar {...props('member')} />)
      const item = (n: RegExp) => screen.getByRole('link', { name: n }).closest('[draggable]')!
      fireEvent.dragStart(item(/random/))
      fireEvent.drop(item(/general/))
      expect(await screen.findByText('not yours')).toBeInTheDocument()
      expect(names()).toEqual(['# general', '# random'])
    })

    it('moves the focused channel with Alt+ArrowUp', () => {
      render(<Sidebar {...props('member')} />)
      fireEvent.keyDown(screen.getByRole('link', { name: /random/ }), { key: 'ArrowUp', altKey: true })
      expect(names()).toEqual(['# random', '# general'])
      expect(orderChannels).toHaveBeenCalledWith('t1', ['c2', 'c1'])
    })

    it('orders direct conversations the same way', () => {
      render(<Sidebar {...props('member')} directs={directs} />)
      fireEvent.keyDown(screen.getByRole('link', { name: /Cy/ }), { key: 'ArrowUp', altKey: true })
      expect(orderDirect).toHaveBeenCalledWith(['d2', 'd1'])
    })
  })
})
