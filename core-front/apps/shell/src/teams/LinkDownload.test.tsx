import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LinkDownload } from './LinkDownload'

describe('LinkDownload', () => {
  it('starts the download once, even when effects run twice', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<StrictMode><LinkDownload token="a/b" info={{ name: 'x.pdf', size: 2048 }} /></StrictMode>)
    expect(click).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: 'Download file' })).toHaveAttribute('href', '/api/teams/links/a%2Fb/download')
    click.mockRestore()
  })

  it('never starts a download for a dead link', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<LinkDownload token="t" info={null} />)
    expect(click).not.toHaveBeenCalled()
    expect(screen.getByText('This link has expired, been revoked, or does not exist.')).toBeInTheDocument()
    click.mockRestore()
  })
})
