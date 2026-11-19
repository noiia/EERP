import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }))
const listFiles = vi.fn()
const linkFolder = vi.fn()
const createFolder = vi.fn()
vi.mock('./client', () => ({
  listFiles: (...a: unknown[]) => listFiles(...a),
  linkFolder: (...a: unknown[]) => linkFolder(...a),
  createFolder: (...a: unknown[]) => createFolder(...a),
}))

import { FolderPanel } from './FolderPanel'

describe('FolderPanel', () => {
  beforeEach(() => {
    listFiles.mockReset().mockImplementation((_t: string, folder?: string) => Promise.resolve(folder
      ? { folder: { id: folder, name: 'Plans', parent_id: null }, path: [{ id: folder, name: 'Plans' }], folders: [], files: [] }
      : { folder: null, path: [], folders: [{ id: 'f9', name: 'Contracts', parent_id: null, created_by: 'u' }], files: [] }))
    linkFolder.mockReset().mockResolvedValue({})
  })

  it('shows the files pane rooted at the linked folder', async () => {
    render(<FolderPanel teamId="t1" channelId="c1" folderId="f1" role="member" onLinked={() => {}} />)
    expect(await screen.findByTestId('teams-files-pane')).toBeInTheDocument()
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith('t1', 'f1'))
    expect(screen.queryByText('All files')).toBeNull()
  })

  it('lets an owner link a folder through the picker', async () => {
    const onLinked = vi.fn()
    render(<FolderPanel teamId="t1" channelId="c1" folderId={null} role="owner" onLinked={onLinked} />)
    fireEvent.click(screen.getByRole('button', { name: 'Link a folder' }))
    fireEvent.click(await screen.findByText('Contracts'))
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith('t1', 'f9'))
    fireEvent.click(screen.getByRole('button', { name: 'Link this folder' }))
    await waitFor(() => expect(linkFolder).toHaveBeenCalledWith('t1', 'c1', 'f9'))
    await waitFor(() => expect(onLinked).toHaveBeenCalled())
  })

  it('shows Go’s message when linking fails', async () => {
    linkFolder.mockRejectedValue(new Error('This folder is already linked to another conversation.'))
    render(<FolderPanel teamId="t1" channelId="c1" folderId={null} role="owner" onLinked={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Link a folder' }))
    fireEvent.click(await screen.findByText('Contracts'))
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith('t1', 'f9'))
    fireEvent.click(screen.getByRole('button', { name: 'Link this folder' }))
    expect(await screen.findByText('This folder is already linked to another conversation.')).toBeInTheDocument()
  })

  it('tells a member that sending files creates the folder', () => {
    render(<FolderPanel teamId="t1" channelId="c1" folderId={null} role="member" onLinked={() => {}} />)
    expect(screen.getByText('No folder yet. Files sent here will create one.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Link a folder' })).toBeNull()
  })

  it('signals a folder created in the panel so the sidebar tree refreshes', async () => {
    createFolder.mockResolvedValue({ id: 'f2' })
    const onFoldersChanged = vi.fn()
    render(<FolderPanel teamId="t1" channelId="c1" folderId="f1" role="owner" onLinked={() => {}} onFoldersChanged={onFoldersChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sub' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onFoldersChanged).toHaveBeenCalledTimes(1))
  })
})
