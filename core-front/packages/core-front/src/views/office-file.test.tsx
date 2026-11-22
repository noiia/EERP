import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { isOfficeFile, OfficeFileLink } from './office-file'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const source = { kind: 'team-file' as const, id: '6c603285-c6ed-42a7-9ba0-ab2f5f890d5b' }

async function session(editable: boolean) {
  const destroy = vi.fn()
  const downloadAs = vi.fn()
  const calls: Array<Record<string, unknown>> = []
  const apiUrl = `https://office.example/${Math.random()}/api.js`
  const config = {
    token: 'server-signed',
    document: { permissions: { edit: editable } },
    editorConfig: { mode: editable ? 'edit' : 'view' },
  }
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ apiUrl, editable, config })))
  vi.stubGlobal('fetch', fetch)
  render(<OfficeFileLink name="Plan.docx" url="/download" source={source} />)
  fireEvent.click(screen.getByRole('link', { name: 'Plan.docx' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  await waitFor(() => expect(document.querySelector(`script[src="${apiUrl}"]`)).not.toBeNull())
  class DocEditor {
    constructor(_id: string, value: Record<string, unknown>) {
      calls.push(value)
      ;(value.events as { onAppReady(): void }).onAppReady()
    }
    destroyEditor = destroy
    downloadAs = downloadAs
  }
  Object.assign(window, { DocsAPI: { DocEditor } })
  await act(async () => {
    fireEvent.load(document.querySelector(`script[src="${apiUrl}"]`)!)
  })
  return { destroy, downloadAs, calls, fetch, config }
}

type Events = {
  onDocumentReady(): void
  onDownloadAs(event: { data: { url: string } }): void
}

describe('Euro-Office integration', () => {
  it('downloads the live document from the editor, named after the file', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { calls, downloadAs } = await session(true)
    const events = calls[0]!.events as Events
    act(() => events.onDocumentReady())
    fireEvent.click(screen.getByRole('link', { name: 'Download' }))
    expect(downloadAs).toHaveBeenCalledWith('docx')
    expect(click).not.toHaveBeenCalled()
    act(() =>
      events.onDownloadAs({
        data: {
          url: 'http://localhost/euro-office/cache/files/k/output.docx?md5=x&filename=output.docx',
        },
      }),
    )
    const a = click.mock.contexts[0] as HTMLAnchorElement
    expect(a.download).toBe('Plan.docx')
    expect(new URL(a.href).searchParams.get('filename')).toBe('Plan.docx')
    expect(new URL(a.href).searchParams.get('md5')).toBe('x')
    // The editor's own File menu download is not ours to save.
    act(() => events.onDownloadAs({ data: { url: 'http://localhost/other' } }))
    expect(click).toHaveBeenCalledOnce()
  })

  it('falls back to the stored copy when the editor never answers', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { calls } = await session(true)
    act(() => (calls[0]!.events as Events).onDocumentReady())
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('link', { name: 'Download' }))
      act(() => vi.advanceTimersByTime(20000))
    } finally {
      vi.useRealTimers()
    }
    expect((click.mock.contexts[0] as HTMLAnchorElement).getAttribute('href')).toBe('/download')
  })

  it('downloads the stored copy before the document is ready', async () => {
    const { downloadAs } = await session(true)
    const link = screen.getByRole('link', { name: 'Download' })
    expect(fireEvent.click(link)).toBe(true) // not prevented: the browser follows href
    expect(downloadAs).not.toHaveBeenCalled()
  })

  it.each([
    'Plan.DOCX',
    'Budget.xlsx',
    'Slides.pptx',
    'Notes.odt',
    'Sheet.ods',
    'Deck.odp',
    'invoice.pdf',
    'readme.txt',
    'data.csv',
  ])('opens supported format %s', (name) => expect(isOfficeFile(name)).toBe(true))

  it('leaves unsupported files as download links', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(<OfficeFileLink name="archive.zip" url="/download" source={source} />)
    fireEvent.click(screen.getByRole('link'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'uses the server-signed configuration (editable=%s) and destroys the editor on close',
    async (editable) => {
      const { destroy, calls, fetch, config } = await session(editable)
      expect(calls[0]).toMatchObject(config)
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/api/office/team-file/${source.id}/session`),
        expect.objectContaining({ cache: 'no-store' }),
      )
      expect(
        screen.getByText(`Euro-Office · ${editable ? 'Editing' : 'Read only'}`),
      ).toBeInTheDocument()
      expect(screen.queryByRole('status')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(destroy).toHaveBeenCalledOnce())
      expect(screen.queryByRole('dialog')).toBeNull()
    },
  )

  it('protects unsynchronized edits when closing', async () => {
    const { calls, destroy } = await session(true)
    act(() =>
      (
        calls[0]!.events as { onDocumentStateChange(event: { data: boolean }): void }
      ).onDocumentStateChange({ data: true }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('dialog', { name: 'Close document?' })).toBeInTheDocument()
    expect(destroy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Close document?' })).toBeNull(),
    )
    act(() =>
      (
        calls[0]!.events as { onDocumentStateChange(event: { data: boolean }): void }
      ).onDocumentStateChange({ data: false }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(destroy).toHaveBeenCalledOnce())
  })

  it('keeps download and retry available when the service is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'OFFICE_UNAVAILABLE', message: 'Euro-Office is not configured.' },
          }),
          { status: 503 },
        ),
      ),
    )
    render(<OfficeFileLink name="Plan.docx" url="/download" source={source} />)
    fireEvent.click(screen.getByRole('link', { name: 'Plan.docx' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Euro-Office is not configured.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Download' })[0]).toHaveAttribute(
      'href',
      '/download',
    )
  })

  it('keeps pending edits until a reload is explicitly confirmed', async () => {
    const { calls, destroy } = await session(true)
    act(() => {
      const events = calls[0]!.events as {
        onDocumentStateChange(event: { data: boolean }): void
        onError(): void
      }
      events.onDocumentStateChange({ data: true })
      events.onError()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByRole('dialog', { name: 'Reload document?' })).toBeInTheDocument()
    expect(destroy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Reload document?' })).toBeNull(),
    )
    expect(destroy).not.toHaveBeenCalled()
  })
})
