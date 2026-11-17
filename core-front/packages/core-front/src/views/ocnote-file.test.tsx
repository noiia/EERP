import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { isOcNote, NoteFileLink, OcNoteDialog } from './ocnote-file'

Range.prototype.getClientRects ??= () => document.body.getClientRects()
Range.prototype.getBoundingClientRect ??= () => document.body.getBoundingClientRect()

const note = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'OpenCloud note' }] }],
})
const fetchMock = vi.fn()
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fetchMock.mockReset()
})

function download(content = note) {
  vi.stubGlobal(
    'fetch',
    fetchMock.mockImplementation(async () => new Response(content, { headers: { etag: '"v1"' } })),
  )
}

describe('note file reader and editor', () => {
  it('detects extensions case-insensitively and leaves other download links alone', () => {
    expect(isOcNote('Notes.OCNOTE')).toBe(true)
    expect(isOcNote('ocnote.txt')).toBe(false)
    render(<NoteFileLink name="document.pdf" url="/api/files/1" />)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/files/1')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens a note read-only and offers its original download', async () => {
    download()
    render(<NoteFileLink name="Notes.ocnote" url="/api/files/1" />)
    fireEvent.click(screen.getByRole('link'))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('OpenCloud note')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/files/1',
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('saves a valid empty new note as bare JSON', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()
    render(<OcNoteDialog name="New.ocnote" onSave={save} onClose={close} />)
    const button = screen.getByRole('button', { name: 'Save' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
        '',
      ),
    )
    expect(close).toHaveBeenCalled()
  })

  it('keeps edits open on a save conflict and asks before discarding them', async () => {
    download()
    const save = vi
      .fn()
      .mockRejectedValue(new Error('This note has changed. Reopen it before saving again.'))
    const close = vi.fn()
    render(<OcNoteDialog name="Notes.ocnote" url="/api/files/1" onSave={save} onClose={close} />)
    await screen.findByText('OpenCloud note')
    fireEvent.click(await screen.findByRole('button', { name: 'Text style' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Heading 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(
      await screen.findByText('This note has changed. Reopen it before saving again.'),
    ).toBeInTheDocument()
    expect(save).toHaveBeenCalledWith(expect.stringContaining('heading'), '"v1"')
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(
      await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }),
    ).toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }))
    expect(close).toHaveBeenCalled()
  })

  it('keeps the editor open after saving and uses the returned version for the next save', async () => {
    download()
    const save = vi
      .fn()
      .mockResolvedValueOnce({ version: '"v2"' })
      .mockResolvedValueOnce({ version: '"v3"' })
    const close = vi.fn()
    render(<OcNoteDialog name="Notes.ocnote" url="/api/files/1" onSave={save} onClose={close} />)
    await screen.findByText('OpenCloud note')
    fireEvent.click(screen.getByRole('button', { name: 'Text style' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Heading 2' }))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Notes.ocnote' }), {
      key: 's',
      ctrlKey: true,
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
    expect(save).toHaveBeenCalledWith(expect.any(String), '"v1"')
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Text style' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Heading 3' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.any(String), '"v2"'))
    expect(close).not.toHaveBeenCalled()
  })

  it('displays read failures and prevents saving invalid documents', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock.mockResolvedValue(
        new Response('{"error":{"message":"No access"}}', { status: 403 }),
      ),
    )
    const { unmount } = render(
      <OcNoteDialog name="Notes.ocnote" url="/api/files/1" onSave={vi.fn()} onClose={vi.fn()} />,
    )
    expect(await screen.findByText('No access')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    unmount()
    download('invalid')
    render(
      <OcNoteDialog name="Notes.ocnote" url="/api/files/1" onSave={vi.fn()} onClose={vi.fn()} />,
    )
    expect(await screen.findByText('Invalid note file.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
