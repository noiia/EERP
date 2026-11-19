import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const c = { createFolder: vi.fn(), updateFolder: vi.fn(), deleteFolder: vi.fn(), listFiles: vi.fn(), getAccess: vi.fn() }
vi.mock('./client', () => ({
  createFolder: (...a: unknown[]) => c.createFolder(...a),
  updateFolder: (...a: unknown[]) => c.updateFolder(...a),
  deleteFolder: (...a: unknown[]) => c.deleteFolder(...a),
  listFiles: (...a: unknown[]) => c.listFiles(...a),
  getAccess: (...a: unknown[]) => c.getAccess(...a),
  setAccess: vi.fn(),
  listGroups: () => Promise.resolve([]),
  folderDownloadUrl: (t: string, f: string) => `/api/teams/${t}/folders/${f}/download`,
}))

import { useSessionStore } from '@eerp/core-front'
import { FolderMenu } from './FolderMenu'
import type { Role } from './client'

const folder = { id: 'f1', name: 'Docs', parent_id: null, created_by: 'me' }
const channels = [{ id: 'c1', team_id: 't1', kind: 'channel', name: 'general', unread: 0, folder_id: 'f1' }]
const members = [{ user_id: 'me', display_name: 'Me', email: 'm@x', role: 'owner' as Role }]

describe('FolderMenu', () => {
  const onChanged = vi.fn()
  beforeEach(() => {
    onChanged.mockReset()
    for (const f of Object.values(c)) f.mockReset().mockResolvedValue(undefined)
    c.listFiles.mockResolvedValue({ folder: null, path: [], folders: [], files: [] })
    c.getAccess.mockResolvedValue({ user_ids: [], group_ids: [] })
    useSessionStore.setState({ identity: { userId: 'me' } } as never)
  })
  const open = (role: Role, f = folder) => {
    render(<FolderMenu teamId="t1" folder={f} role={role} channels={channels} members={members} onChanged={onChanged} onAccessSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Folder options Docs' }))
  }
  // After a dialog closes (its exit transition), the menu button is reachable again.
  const reopen = async () => {
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Folder options Docs' }))
  }
  const items = () => screen.getAllByRole('menuitem').map((i) => i.textContent)

  it('follows the role: owners get everything, guests only download', () => {
    open('owner')
    expect(items()).toEqual(['New subfolder', 'Download', 'Rename', 'Move', 'Manage access', 'Delete'])
    expect(screen.getByRole('menuitem', { name: 'Download' })).toHaveAttribute('href', '/api/teams/t1/folders/f1/download')
  })

  it('a member manages their own folder, not access; another member\'s folder only gets new subfolder + download', () => {
    open('member')
    expect(items()).toEqual(['New subfolder', 'Download', 'Rename', 'Move', 'Delete'])
  })

  it('guest and someone else\'s folder', () => {
    open('guest', { ...folder, created_by: 'other' })
    expect(items()).toEqual(['Download'])
  })

  it('creates a subfolder once, even on a double click, and reports a taken name in the dialog', async () => {
    let resolve!: () => void
    c.createFolder.mockReturnValueOnce(new Promise<void>((r) => { resolve = r }))
    open('member')
    fireEvent.click(screen.getByRole('menuitem', { name: 'New subfolder' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Specs' } })
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(save)
    fireEvent.click(save)
    expect(c.createFolder).toHaveBeenCalledTimes(1)
    expect(c.createFolder).toHaveBeenCalledWith('t1', 'Specs', 'f1')
    resolve()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())

    c.createFolder.mockRejectedValueOnce(new Error('A folder with this name already exists in this folder.'))
    await reopen()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New subfolder' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Specs' } })
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' })
    expect(await screen.findByText('A folder with this name already exists in this folder.')).toBeInTheDocument()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('renames, deletes and moves', async () => {
    open('owner')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Docs')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Papers' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(c.updateFolder).toHaveBeenCalledWith('t1', 'f1', { name: 'Papers' }))

    await reopen()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    await waitFor(() => expect(c.deleteFolder).toHaveBeenCalledWith('t1', 'f1'))

    await reopen()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Move here' }))
    await waitFor(() => expect(c.updateFolder).toHaveBeenCalledWith('t1', 'f1', { parent_id: '' }))
    expect(onChanged).toHaveBeenCalledTimes(3)
  })

  it('manage access opens the linked conversation\'s access dialog', async () => {
    open('owner')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage access' }))
    await waitFor(() => expect(c.getAccess).toHaveBeenCalledWith('t1', 'c1'))
  })
})
