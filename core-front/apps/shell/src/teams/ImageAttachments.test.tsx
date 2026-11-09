import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ImageAttachments } from './ImageAttachments'

const a = (over: object) => ({ id: 'x', filename: 'f', mime: 'application/pdf', size: 1, ...over })

describe('ImageAttachments', () => {
  it('renders a png thumbnail from the right route for both kinds', () => {
    render(<ImageAttachments attachments={[
      a({ id: 'f1', filename: 'one.png', mime: 'image/png', kind: 'file' }),
      a({ id: 'a1', filename: 'two.png', mime: 'image/png', kind: 'attachment' }),
    ]} />)
    const one = screen.getByRole('img', { name: 'one.png' })
    expect(one).toHaveAttribute('src', '/api/teams/files/f1/download')
    expect(one).toHaveAttribute('loading', 'lazy')
    expect(screen.getByRole('img', { name: 'two.png' })).toHaveAttribute('src', '/api/teams/attachments/a1')
  })

  it('renders an svg as a chip, never inline', () => {
    render(<ImageAttachments attachments={[a({ id: 's1', filename: 'logo.svg', mime: 'image/svg+xml', kind: 'file' })]} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'logo.svg' })).toHaveAttribute('href', '/api/teams/files/s1/download')
  })

  it('opens a viewer with a download link on click', async () => {
    render(<ImageAttachments attachments={[a({ id: 'f1', filename: 'one.png', mime: 'image/png', kind: 'file' })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'one.png' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('one.png')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/teams/files/f1/download')
  })

  it('shows a deleted file as such', () => {
    render(<ImageAttachments attachments={[a({ id: 'f1', filename: '', kind: 'file', deleted: true })]} />)
    expect(screen.getByText('File deleted')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
