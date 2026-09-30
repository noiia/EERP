import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PictureClientProvider, useSessionStore, type PictureClient } from '@eerp/core-front'
import { CompanyLogo } from './CompanyLogo'
import { FaviconSettings } from './FaviconSettings'

function client(existing: boolean): PictureClient & { upload: ReturnType<typeof vi.fn> } {
  const meta = { id: 'p1', table_name: 'company', record_id: 'c1', field: 'logo', mime: 'image/png', size: 3 }
  return {
    find: vi.fn(async () => (existing ? meta : null)),
    upload: vi.fn(async () => ({ ...meta, id: 'p2' })),
    remove: vi.fn(async () => {}),
    url: (id: string) => `/api/pictures/${id}`,
  }
}
const withPerms = (permissions: string[]) =>
  useSessionStore.setState({ identity: { userId: 'u', tenantId: 't1', roles: [], permissions } as never })

describe('CompanyLogo', () => {
  it('shows the logo; an editor uploads a new one on the company anchor', async () => {
    withPerms(['company:company:write'])
    const c = client(true)
    render(<PictureClientProvider client={c}><CompanyLogo companyId="c1" /></PictureClientProvider>)
    expect((await screen.findByAltText('Company logo')).getAttribute('src')).toContain('/api/pictures/p1')
    const file = new File(['x'], 'logo.png', { type: 'image/png' })
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } })
    await waitFor(() => expect(c.upload).toHaveBeenCalledWith({ table: 'company', recordId: 'c1', field: 'logo' }, file, 'logo.png'))
  })

  it('renders nothing without a logo or the write permission', async () => {
    withPerms([])
    const c = client(false)
    const { container } = render(<PictureClientProvider client={c}><CompanyLogo companyId="c1" /></PictureClientProvider>)
    await waitFor(() => expect(c.find).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})

describe('FaviconSettings', () => {
  it('uploads on the workspace anchor of the caller tenant', async () => {
    withPerms(['pictures:pictures:write'])
    const c = client(false)
    render(<PictureClientProvider client={c}><FaviconSettings /></PictureClientProvider>)
    const file = new File(['x'], 'icon.png', { type: 'image/png' })
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } })
    await waitFor(() => expect(c.upload).toHaveBeenCalledWith({ table: 'workspace', recordId: 't1', field: 'favicon' }, file, 'icon.png'))
  })
})
