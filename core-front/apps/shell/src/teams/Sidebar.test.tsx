import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, prefetch: vi.fn() }) }))
const listFiles = vi.fn<(team: string, folder?: string) => Promise<unknown>>(() => Promise.reject(new Error('Not Found')))
const createChannel = vi.fn()
const openDirect = vi.fn()
vi.mock('./client', () => ({
  listFiles: (t: string, f?: string) => listFiles(t, f),
  directory: () => Promise.resolve([{ id: 'u2', display_name: 'Bob', email: 'b@x' }]),
  createChannel: (...a: unknown[]) => createChannel(...a),
  openDirect: (...a: unknown[]) => openDirect(...a),
}))

import { Sidebar } from './Sidebar'
import type { Role } from './client'

const props = (role: Role) => ({
  teamId: 't1',
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
