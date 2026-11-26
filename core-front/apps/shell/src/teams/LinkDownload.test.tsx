import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LinkDownload } from './LinkDownload'

describe('LinkDownload', () => {
  it('starts the download once, even when effects run twice', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<StrictMode><LinkDownload token="a/b" /></StrictMode>)
    expect(click).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: 'Download file' })).toHaveAttribute('href', '/api/teams/links/a%2Fb/download')
    click.mockRestore()
  })
})
