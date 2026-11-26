import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const setShares = vi.fn().mockResolvedValue([])
const createLink = vi.fn()
const revokeLink = vi.fn().mockResolvedValue(undefined)
const getLinks = vi.fn()
vi.mock('./client', () => ({
  directory: () => Promise.resolve([{ id: 'u1', display_name: 'Alice', email: 'a@x' }, { id: 'u2', display_name: 'Bob', email: 'b@x' }]),
  getShares: () => Promise.resolve([{ user_id: 'u1', display_name: 'Alice', email: 'a@x' }]),
  setShares: (...a: unknown[]) => setShares(...a),
  getLinks: (...a: unknown[]) => getLinks(...a),
  createLink: (...a: unknown[]) => createLink(...a),
  revokeLink: (...a: unknown[]) => revokeLink(...a),
}))
import { ShareDialog, linkExpiry } from './ShareDialog'

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const inDays = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}

beforeEach(() => {
  getLinks.mockResolvedValue([
    { id: 'l1', expires_at: '2030-01-02T10:00:00Z', created_by_name: 'Alice', created_at: '2030-01-01T10:00:00Z', download_count: 3, last_download_at: null },
  ])
  createLink.mockReset()
  revokeLink.mockClear()
})

describe('ShareDialog', () => {
  it('preselects current shares and saves the chosen ids', async () => {
    const onSaved = vi.fn()
    render(<ShareDialog open fileId="f1" onClose={vi.fn()} onSaved={onSaved} />)
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    const input = screen.getByRole('combobox', { name: /share with/i })
    fireEvent.mouseDown(input)
    fireEvent.click(await screen.findByRole('option', { name: 'Bob' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setShares).toHaveBeenCalledWith('f1', ['u1', 'u2']))
    expect(onSaved).toHaveBeenCalled()
  })

  it('defaults the link expiry to 7 days, at most 90', async () => {
    render(<ShareDialog open fileId="f1" onClose={vi.fn()} onSaved={vi.fn()} />)
    const date = (await screen.findByLabelText('Expires on')) as HTMLInputElement
    expect(date.value).toBe(ymd(inDays(7)))
    expect(date.max).toBe(ymd(inDays(90)))
  })

  it('creates a link, copies it and shows it once', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    createLink.mockResolvedValue({ id: 'l2', url: '/app/teams/links/tok', expires_at: '2030-01-08T22:59:00Z', created_by_name: 'Alice', created_at: '', download_count: 0, last_download_at: null })
    render(<ShareDialog open fileId="f1" onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    await waitFor(() => expect(createLink).toHaveBeenCalledWith('f1', linkExpiry(ymd(inDays(7)))))
    const url = `${window.location.origin}/app/teams/links/tok`
    expect(await screen.findByDisplayValue(url)).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(url)
  })

  it('lists live links and revokes one', async () => {
    render(<ShareDialog open fileId="f1" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(await screen.findByText(/3 downloads/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(revokeLink).toHaveBeenCalledWith('l1'))
    await waitFor(() => expect(screen.queryByText(/3 downloads/)).not.toBeInTheDocument())
  })

  it('shows why a link was refused', async () => {
    createLink.mockRejectedValue(new Error('expires_at must be in the future and at most 90 days away.'))
    render(<ShareDialog open fileId="f1" onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    expect(await screen.findByText(/at most 90 days away/)).toBeInTheDocument()
  })
})

describe('linkExpiry', () => {
  it('is the end of the picked local day, capped just under 90 days from now', () => {
    const day = ymd(inDays(7))
    const end = new Date(linkExpiry(day))
    expect(ymd(end)).toBe(day)
    expect(end.getHours()).toBe(23)
    const capped = new Date(linkExpiry(ymd(inDays(90)))).getTime()
    expect(capped).toBeLessThan(Date.now() + 90 * 24 * 3600 * 1000)
  })
})
