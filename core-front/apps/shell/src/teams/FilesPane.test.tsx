import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }))
const c = {
  listFiles: vi.fn(),
  searchFiles: vi.fn(),
  deleteFile: vi.fn(),
  updateFile: vi.fn(),
  createDocument: vi.fn(),
  uploadFile: vi.fn(),
  createFolder: vi.fn(),
  updateFolder: vi.fn(),
  deleteFolder: vi.fn(),
}
vi.mock('./client', () => ({
  listFiles: (...a: unknown[]) => c.listFiles(...a),
  searchFiles: (...a: unknown[]) => c.searchFiles(...a),
  deleteFile: (...a: unknown[]) => c.deleteFile(...a),
  updateFile: (...a: unknown[]) => c.updateFile(...a),
  createDocument: (...a: unknown[]) => c.createDocument(...a),
  uploadFile: (...a: unknown[]) => c.uploadFile(...a),
  createFolder: (...a: unknown[]) => c.createFolder(...a),
  updateFolder: (...a: unknown[]) => c.updateFolder(...a),
  deleteFolder: (...a: unknown[]) => c.deleteFolder(...a),
  getShares: () => Promise.resolve([]),
  setShares: () => Promise.resolve([]),
  directory: () => Promise.resolve([]),
  getLinks: () => Promise.resolve([]),
}))

import { preloadLazyComponents, useSessionStore } from '@eerp/core-front'
import { FilesPane, sortItems } from './FilesPane'
import { fileIconSrc } from './FileIcon'

beforeAll(() => preloadLazyComponents())
afterEach(() => vi.unstubAllGlobals())

Range.prototype.getClientRects ??= () => document.body.getClientRects()
Range.prototype.getBoundingClientRect ??= () => document.body.getBoundingClientRect()

const listing = {
  folder: { id: 'f1', name: 'Docs', parent_id: null },
  path: [{ id: 'f1', name: 'Docs' }],
  folders: [{ id: 'f2', name: 'Specs', parent_id: 'f1', created_by: 'me' }],
  files: [
    {
      id: 'a',
      name: 'mine.pdf',
      folder_id: 'f1',
      mime: 'application/pdf',
      size: 2048,
      uploaded_by: 'me',
      uploaded_by_name: 'Me',
      created_at: '2026-01-02T10:00:00Z',
      updated_at: '2026-03-04T10:00:00Z',
      shared_with: 0,
    },
    {
      id: 'b',
      name: 'theirs.pdf',
      folder_id: 'f1',
      mime: 'application/pdf',
      size: 10,
      uploaded_by: 'other',
      uploaded_by_name: 'Other',
      created_at: '',
      shared_with: 0,
    },
  ],
}

describe('FilesPane', () => {
  beforeEach(() => {
    for (const f of Object.values(c)) f.mockReset().mockResolvedValue(undefined)
    c.listFiles.mockResolvedValue(listing)
    useSessionStore.setState({ identity: { userId: 'me' } } as never)
  })

  it('reads the folder once, not on every render (a new listing must not refetch it)', async () => {
    const onFolderName = vi.fn()
    render(<FilesPane teamId="t1" folderId="f1" role="owner" onFolderName={onFolderName} />)
    await waitFor(() => expect(onFolderName).toHaveBeenCalledWith('Docs'))
    await new Promise((r) => setTimeout(r, 100))
    expect(c.listFiles).toHaveBeenCalledTimes(1)
  })

  it('shows the breadcrumb, folder links and download links', async () => {
    render(<FilesPane teamId="t1" folderId="f1" role="owner" />)
    expect(await screen.findByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      expect.stringContaining('/teams/t1/files?folder=f1'),
    )
    expect(screen.getByRole('link', { name: 'Specs' })).toHaveAttribute(
      'href',
      expect.stringContaining('/teams/t1/files?folder=f2'),
    )
    expect(screen.getByRole('link', { name: 'mine.pdf' })).toHaveAttribute(
      'href',
      '/api/teams/files/a/download',
    )
    expect(c.listFiles).toHaveBeenCalledWith('t1', 'f1')
  })

  it('a double-clicked Save creates one folder, and a taken name shows in the dialog', async () => {
    let resolve!: () => void
    c.createFolder.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolve = r
      }),
    )
    render(<FilesPane teamId="t1" folderId="f1" role="member" />)
    fireEvent.click(await screen.findByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Specs' } })
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(save)
    fireEvent.click(save)
    expect(c.createFolder).toHaveBeenCalledTimes(1)
    resolve()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    c.createFolder.mockRejectedValueOnce(
      new Error('A folder with this name already exists in this folder.'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Specs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(
      await within(screen.getByRole('dialog')).findByText(
        'A folder with this name already exists in this folder.',
      ),
    ).toBeInTheDocument()
  })

  it('starts the breadcrumb at rootFolderId, without All files', async () => {
    c.listFiles.mockResolvedValue({
      ...listing,
      folder: { id: 'f2', name: 'Specs', parent_id: 'f1' },
      path: [
        { id: 'f1', name: 'Docs' },
        { id: 'f2', name: 'Specs' },
      ],
      folders: [{ id: 'f3', name: 'Drafts', parent_id: 'f2', created_by: 'me' }],
    })
    render(<FilesPane teamId="t1" rootFolderId="f2" role="owner" compact />)
    const crumbs = within(await screen.findByRole('navigation', { name: 'Path' }))
    await crumbs.findByText('Specs')
    expect(crumbs.queryByText('Docs')).toBeNull()
    expect(crumbs.queryByText('All files')).toBeNull()
    expect(c.listFiles).toHaveBeenCalledWith('t1', 'f2')
    fireEvent.click(screen.getByText('Drafts'))
    await waitFor(() => expect(c.listFiles).toHaveBeenLastCalledWith('t1', 'f3'))
  })

  it('hides New folder and Upload for a guest, and any row actions', async () => {
    render(<FilesPane teamId="t1" role="guest" />)
    await screen.findByText('mine.pdf')
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('lets an owner edit every row but a member only their own', async () => {
    const { unmount } = render(<FilesPane teamId="t1" role="owner" />)
    await screen.findByText('mine.pdf')
    expect(screen.getAllByRole('button', { name: 'Rename' })).toHaveLength(3)
    unmount()
    render(<FilesPane teamId="t1" role="member" />)
    await screen.findByText('mine.pdf')
    expect(screen.getAllByRole('button', { name: 'Rename' })).toHaveLength(2)
  })

  it('asks for confirmation before deleting a file', async () => {
    render(<FilesPane teamId="t1" role="owner" />)
    const row = (await screen.findByText('theirs.pdf')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }))
    expect(c.deleteFile).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(c.deleteFile).toHaveBeenCalledWith('t1', 'b'))
  })

  it('moves a file through the folder picker', async () => {
    render(<FilesPane teamId="t1" role="owner" />)
    const row = (await screen.findByText('mine.pdf')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Move' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Move here' }))
    await waitFor(() => expect(c.updateFile).toHaveBeenCalledWith('t1', 'a', { folder_id: '' }))
  })

  it('moves a file into a subfolder', async () => {
    render(<FilesPane teamId="t1" role="owner" />)
    const row = (await screen.findByText('mine.pdf')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Move' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByText('Specs'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }))
    await waitFor(() => expect(c.updateFile).toHaveBeenCalledWith('t1', 'a', { folder_id: 'f2' }))
  })

  it('moves a folder, hides it from the picker and shows the server refusal', async () => {
    c.listFiles.mockResolvedValue({
      ...listing,
      folders: [...listing.folders, { id: 'f3', name: 'Other', parent_id: 'f1', created_by: 'me' }],
    })
    c.updateFolder.mockRejectedValue(new Error('cannot move a folder into itself'))
    render(<FilesPane teamId="t1" role="owner" />)
    const row = (await screen.findByText('Specs')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Move' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('Other')
    expect(within(dialog).queryByText('Specs')).toBeNull()
    fireEvent.click(within(dialog).getByText('Other'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }))
    await waitFor(() =>
      expect(c.updateFolder).toHaveBeenCalledWith('t1', 'f2', { parent_id: 'f3' }),
    )
    expect(await within(dialog).findByText('cannot move a folder into itself')).toBeInTheDocument()
  })

  it('uploads several files into the current folder', async () => {
    render(<FilesPane teamId="t1" folderId="f1" role="member" />)
    await screen.findByText('mine.pdf')
    const files = [new File(['x'], 'one.txt'), new File(['y'], 'two.txt')]
    fireEvent.change(screen.getByTestId('teams-upload-input'), { target: { files } })
    await waitFor(() => expect(c.uploadFile).toHaveBeenCalledTimes(2))
    expect(c.uploadFile).toHaveBeenCalledWith('t1', files[0], 'f1')
  })

  it('creates an Office document in the currently browsed folder', async () => {
    c.createDocument.mockResolvedValue({ id: 'doc1', name: 'Meeting.docx' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })))
    render(<FilesPane teamId="t1" folderId="f1" role="member" />)
    fireEvent.click(await screen.findByRole('button', { name: 'New document' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Meeting' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('dialog', { name: 'Meeting.docx' })).toBeInTheDocument()
    expect(c.createDocument).toHaveBeenCalledWith('t1', 'Meeting', 'docx', 'f1')
    expect(c.uploadFile).not.toHaveBeenCalled()
  })

  it.each(['owner', 'member', 'guest'] as const)(
    'opens Office files for a %s through the authorized endpoint',
    async (role) => {
      c.listFiles.mockResolvedValue({
        ...listing,
        files: [{ ...listing.files[0], name: 'Plan.docx' }],
      })
      const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }))
      vi.stubGlobal('fetch', fetch)
      render(<FilesPane teamId="t1" role={role} />)
      fireEvent.click(await screen.findByRole('link', { name: 'Plan.docx' }))
      expect(await screen.findByRole('dialog', { name: 'Plan.docx' })).toBeInTheDocument()
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/office/team-file/a/session'),
          expect.anything(),
        ),
      )
      if (role === 'guest')
        expect(screen.queryByRole('button', { name: 'New document' })).toBeNull()
    },
  )

  it.each([
    ['member', 'me', true],
    ['member', 'other', false],
    ['owner', 'other', true],
  ] as const)('the office viewer offers Share to a %s on a file by %s: %s', async (role, by, shown) => {
    c.listFiles.mockResolvedValue({
      ...listing,
      files: [{ ...listing.files[0], name: 'Plan.docx', uploaded_by: by }],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })))
    render(<FilesPane teamId="t1" role={role} />)
    fireEvent.click(await screen.findByRole('link', { name: 'Plan.docx' }))
    const viewer = await screen.findByRole('dialog', { name: 'Plan.docx' })
    const share = within(viewer).queryByRole('button', { name: 'Share' })
    if (!shown) return expect(share).toBeNull()
    fireEvent.click(share!)
    expect(await screen.findByRole('dialog', { name: 'Share file' })).toBeInTheDocument()
  })

  it('says so when file storage is not configured', async () => {
    c.listFiles.mockRejectedValue(Object.assign(new Error(''), { status: 404 }))
    render(<FilesPane teamId="t1" role="owner" />)
    expect(await screen.findByText(/not configured/i)).toBeInTheDocument()
  })

  it('says a stale folder no longer exists, with a link to the root', async () => {
    c.listFiles.mockRejectedValue(
      Object.assign(new Error('No such folder.'), { status: 404, code: 'NOT_FOUND' }),
    )
    render(<FilesPane teamId="t1" folderId="gone" role="owner" />)
    expect(await screen.findByText('This folder no longer exists.')).toBeInTheDocument()
    expect(screen.queryByText(/not configured/i)).toBeNull()
    expect(screen.getByRole('link', { name: 'All files' })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/teams\/t1\/files$/),
    )
  })

  it('signals folder changes but not file ones', async () => {
    const onFoldersChanged = vi.fn()
    c.createFolder.mockResolvedValue({ id: 'f9' })
    render(<FilesPane teamId="t1" role="owner" onFoldersChanged={onFoldersChanged} />)
    const row = (await screen.findByText('theirs.pdf')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    )
    await waitFor(() => expect(c.deleteFile).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onFoldersChanged).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Plans' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onFoldersChanged).toHaveBeenCalledTimes(1))
  })

  it('shows the created and last modified dates', async () => {
    render(<FilesPane teamId="t1" role="owner" />)
    const row = (await screen.findByText('mine.pdf')).closest('tr') as HTMLElement
    expect(
      within(row).getByText(new Date('2026-01-02T10:00:00Z').toLocaleString()),
    ).toBeInTheDocument()
    expect(
      within(row).getByText(new Date('2026-03-04T10:00:00Z').toLocaleString()),
    ).toBeInTheDocument()
  })

  it('offers a download on every file, guests included', async () => {
    render(<FilesPane teamId="t1" role="guest" />)
    const row = (await screen.findByText('theirs.pdf')).closest('tr') as HTMLElement
    expect(within(row).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/teams/files/b/download',
    )
  })

  it('folds the row actions into a ⋮ menu when narrow', async () => {
    render(<FilesPane teamId="t1" role="owner" compact />)
    const row = (await screen.findByText('theirs.pdf')).closest('tr') as HTMLElement
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'More actions theirs.pdf' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    )
    await waitFor(() => expect(c.deleteFile).toHaveBeenCalledWith('t1', 'b'))
  })

  const dt = (data: Record<string, string>, files: File[] = []) => ({
    types: [...Object.keys(data), ...(files.length ? ['Files'] : [])],
    getData: (k: string) => data[k] ?? '',
    setData: (k: string, v: string) => {
      data[k] = v
    },
    files,
  })

  it('uploads desktop files dropped on the pane or on a folder', async () => {
    render(<FilesPane teamId="t1" folderId="f1" role="member" />)
    const pane = await screen.findByTestId('teams-files-pane')
    await screen.findByText('mine.pdf')
    const file = new File(['x'], 'one.txt')
    fireEvent.dragOver(pane, { dataTransfer: dt({}, [file]) })
    fireEvent.drop(pane, { dataTransfer: dt({}, [file]) })
    await waitFor(() => expect(c.uploadFile).toHaveBeenCalledWith('t1', file, 'f1'))
    fireEvent.drop(screen.getByText('Specs').closest('tr') as HTMLElement, {
      dataTransfer: dt({}, [file]),
    })
    await waitFor(() => expect(c.uploadFile).toHaveBeenCalledWith('t1', file, 'f2'))
  })

  it('moves a dragged row into the folder it is dropped on', async () => {
    const onFoldersChanged = vi.fn()
    render(<FilesPane teamId="t1" folderId="f1" role="owner" onFoldersChanged={onFoldersChanged} />)
    const data: Record<string, string> = {}
    fireEvent.dragStart((await screen.findByText('mine.pdf')).closest('tr') as HTMLElement, {
      dataTransfer: dt(data),
    })
    const specs = screen.getByText('Specs').closest('tr') as HTMLElement
    fireEvent.drop(specs, { dataTransfer: dt(data) })
    await waitFor(() => expect(c.updateFile).toHaveBeenCalledWith('t1', 'a', { folder_id: 'f2' }))
    // A folder dropped on itself stays put.
    const self: Record<string, string> = {}
    fireEvent.dragStart(specs, { dataTransfer: dt(self) })
    fireEvent.drop(specs, { dataTransfer: dt(self) })
    expect(c.updateFolder).not.toHaveBeenCalled()
    // Onto a breadcrumb: up to that folder.
    fireEvent.dragStart(specs, { dataTransfer: dt(self) })
    fireEvent.drop(
      within(screen.getByRole('navigation', { name: 'Path' })).getByText('All files'),
      { dataTransfer: dt(self) },
    )
    await waitFor(() => expect(c.updateFolder).toHaveBeenCalledWith('t1', 'f2', { parent_id: '' }))
    await waitFor(() => expect(onFoldersChanged).toHaveBeenCalled())
  })

  it('lets a guest neither drag rows nor drop files', async () => {
    render(<FilesPane teamId="t1" folderId="f1" role="guest" />)
    const row = (await screen.findByText('mine.pdf')).closest('tr') as HTMLElement
    expect(row).not.toHaveAttribute('draggable')
    fireEvent.drop(await screen.findByTestId('teams-files-pane'), {
      dataTransfer: dt({}, [new File(['x'], 'x')]),
    })
    expect(c.uploadFile).not.toHaveBeenCalled()
  })

  it('sorts the listing with the sort select', async () => {
    render(<FilesPane teamId="t1" folderId="f1" role="owner" />)
    await screen.findByRole('link', { name: 'mine.pdf' })
    const names = () =>
      screen
        .getAllByRole('link')
        .map((l) => l.textContent)
        .filter((n) => n?.endsWith('.pdf'))
    expect(names()).toEqual(['mine.pdf', 'theirs.pdf'])
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Sort by' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Name (Z to A)' }))
    expect(names()).toEqual(['theirs.pdf', 'mine.pdf'])
  })

  it('searches the whole tree and shows each hit with its folder path', async () => {
    c.searchFiles.mockResolvedValue({
      folders: [],
      files: [
        {
          ...listing.files[0],
          name: 'deep.docx',
          path: [
            { id: 'x', name: 'Reports' },
            { id: 'y', name: '2026' },
          ],
        },
      ],
    })
    render(<FilesPane teamId="t1" folderId="f1" role="owner" />)
    await screen.findByRole('link', { name: 'mine.pdf' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search all files' }), {
      target: { value: 'deep' },
    })
    expect(await screen.findByRole('link', { name: 'deep.docx' })).toBeInTheDocument()
    expect(c.searchFiles).toHaveBeenCalledWith('t1', 'deep')
    expect(screen.getByText('Reports / 2026')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'mine.pdf' })).toBeNull()
    c.searchFiles.mockResolvedValue({ folders: [], files: [] })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search all files' }), {
      target: { value: 'nothing' },
    })
    expect(await screen.findByText('No files found.')).toBeInTheDocument()
  })

  it('keeps a conversation panel search below its root folder', async () => {
    c.searchFiles.mockResolvedValue({
      folders: [],
      files: [
        { ...listing.files[0], id: 'in', name: 'in.txt', path: [{ id: 'f1', name: 'Docs' }] },
        { ...listing.files[0], id: 'out', name: 'out.txt', path: [] },
      ],
    })
    render(<FilesPane teamId="t1" rootFolderId="f1" role="owner" compact />)
    await screen.findByRole('link', { name: 'mine.pdf' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search all files' }), {
      target: { value: 'txt' },
    })
    expect(await screen.findByRole('link', { name: 'in.txt' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'out.txt' })).toBeNull()
  })
})

describe('sortItems', () => {
  const items = [
    { name: 'b10', size: 1, updated_at: '2026-01-03T00:00:00Z' },
    { name: 'B2', size: 3, created_at: '2026-01-01T00:00:00Z' },
    { name: 'a', size: 2 },
  ]
  it.each([
    ['name', ['a', 'B2', 'b10']],
    ['-name', ['b10', 'B2', 'a']],
    ['-size', ['B2', 'a', 'b10']],
    ['size', ['b10', 'a', 'B2']],
    ['-updated', ['b10', 'B2', 'a']],
    ['updated', ['a', 'B2', 'b10']],
  ] as const)('%s', (key, want) => {
    expect(sortItems(items, key).map((i) => i.name)).toEqual(want)
  })
})

describe('fileIconSrc', () => {
  it('maps extensions to the Euro-Office icons, unknown ones to neutral', () => {
    const docx = fileIconSrc('a.docx')
    expect(fileIconSrc('Plan.DOCX')).toBe(docx)
    expect(fileIconSrc('photo.jpeg')).toBe(fileIconSrc('photo.jpg'))
    expect(fileIconSrc('archive.zip')).not.toBe(docx)
    expect(fileIconSrc('.hidden')).toBe(fileIconSrc('archive.zip'))
  })
})
