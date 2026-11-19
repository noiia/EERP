import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ImageAttachments } from './ImageAttachments'
import { preloadLazyComponents } from '@eerp/core-front'

beforeAll(() => preloadLazyComponents())
afterEach(() => vi.unstubAllGlobals())

const a = (over: object) => ({ id: 'x', filename: 'f', mime: 'application/pdf', size: 1, ...over })

describe('ImageAttachments', () => {
  it.each(['file', 'attachment'] as const)(
    'opens an Office document from a chat %s',
    async (kind) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }))
      vi.stubGlobal('fetch', fetchMock)
      render(<ImageAttachments attachments={[a({ id: 'n1', filename: 'Chat.docx', kind })]} />)
      fireEvent.click(screen.getByRole('link', { name: 'Chat.docx (1 B)' }))
      expect(
        await screen.findByText(
          'The document could not be opened. Try again or download the file.',
        ),
      ).toBeInTheDocument()
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(
          `/api/office/${kind === 'file' ? 'team-file' : 'team-attachment'}/n1/session`,
        ),
        expect.any(Object),
      )
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    },
  )
  it('renders a png thumbnail from the right route for both kinds', () => {
    render(
      <ImageAttachments
        attachments={[
          a({ id: 'f1', filename: 'one.png', mime: 'image/png', kind: 'file' }),
          a({ id: 'a1', filename: 'two.png', mime: 'image/png', kind: 'attachment' }),
        ]}
      />,
    )
    const one = screen.getByRole('img', { name: 'one.png' })
    expect(one).toHaveAttribute('src', '/api/teams/files/f1/download')
    expect(one).toHaveAttribute('loading', 'lazy')
    expect(screen.getByRole('img', { name: 'two.png' })).toHaveAttribute(
      'src',
      '/api/teams/attachments/a1',
    )
  })

  it('renders an svg as a chip, never inline', () => {
    render(
      <ImageAttachments
        attachments={[a({ id: 's1', filename: 'logo.svg', mime: 'image/svg+xml', kind: 'file' })]}
      />,
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'logo.svg (1 B)' })).toHaveAttribute(
      'href',
      '/api/teams/files/s1/download',
    )
  })

  it('opens a viewer with a download link on click', async () => {
    render(
      <ImageAttachments
        attachments={[a({ id: 'f1', filename: 'one.png', mime: 'image/png', kind: 'file' })]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'one.png' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('one.png')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/teams/files/f1/download',
    )
  })

  it('shows a deleted file as such', () => {
    render(
      <ImageAttachments
        attachments={[a({ id: 'f1', filename: '', kind: 'file', deleted: true })]}
      />,
    )
    expect(screen.getByText('File deleted')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('shows a file chip with its name and size', () => {
    render(
      <ImageAttachments
        attachments={[a({ id: 'p1', filename: 'plan.pdf', size: 2048, kind: 'attachment' })]}
      />,
    )
    expect(screen.getByRole('link', { name: 'plan.pdf (2 KB)' })).toBeInTheDocument()
  })
})
