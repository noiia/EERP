import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import DatabaseManagementPage from './page'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('DatabaseManagementPage', () => {
  it('sends the typed master key as X-Master-Key on every call and renders the list', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/v1/database-management/databases')
      expect((init.headers as Record<string, string>)['X-Master-Key']).toBe('secret')
      return jsonResponse(200, [{ name: 'poc', size_bytes: 2048, active: true }])
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DatabaseManagementPage />)
    fireEvent.change(screen.getByLabelText(/master key/i), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: /load databases/i }))

    expect(await screen.findByText('poc')).toBeInTheDocument()
    expect(await screen.findByText('active')).toBeInTheDocument()
  })

  it('surfaces the server error message on a failed action instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(401, { error: { message: 'Invalid or missing master key.' } }),
      ),
    )

    render(<DatabaseManagementPage />)
    fireEvent.change(screen.getByLabelText(/master key/i), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /load databases/i }))

    expect(await screen.findByText('Invalid or missing master key.')).toBeInTheDocument()
  })

  it('creates a database and reloads the list', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(url).toBe('/api/v1/database-management/databases')
        expect(JSON.parse(init.body as string)).toEqual({ name: 'newdb' })
        return jsonResponse(201, { name: 'newdb' })
      }
      return jsonResponse(200, [{ name: 'newdb', size_bytes: 0, active: false }])
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DatabaseManagementPage />)
    fireEvent.change(screen.getByLabelText(/master key/i), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'newdb' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(screen.getByText(/created and initialized/i)).toBeInTheDocument())
    expect(await screen.findByText('newdb')).toBeInTheDocument()
  })
})

describe('DatabaseManagementPage — every status and row action', () => {
  const list = [
    { name: 'poc', size_bytes: 3 * 1024 * 1024, active: true, status: 'ready' },
    { name: 'staging', size_bytes: 0, active: false, status: 'ready' },
    { name: 'fresh', size_bytes: 100, active: false, status: 'unprepared' },
    { name: 'broken', size_bytes: 0, active: false, status: 'failed', prepare_error: 'disk full' },
    {
      name: 'warming',
      size_bytes: 0,
      active: false,
      status: 'preparing',
      progress_done: 1,
      progress_total: 4,
      elapsed_seconds: 65,
      estimated_seconds: 130,
    },
  ]
  let calls: { url: string; method: string; body?: unknown }[]

  function stubServer() {
    calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ url, method, body: init?.body })
        if (method === 'GET' && url.endsWith('/databases')) return jsonResponse(200, list)
        if (url.includes('/extract'))
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        return new Response(null, { status: method === 'DELETE' ? 204 : 200 })
      }),
    )
  }

  async function loaded() {
    render(<DatabaseManagementPage />)
    fireEvent.change(screen.getByLabelText(/master key/i), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: /load databases/i }))
    await screen.findByText('staging')
  }

  function row(name: string) {
    return within(screen.getByText(name).closest('tr') as HTMLElement)
  }

  it('renders each status: size, ready, failed with its reason, and preparing progress', async () => {
    stubServer()
    await loaded()
    expect(screen.getByText('3.0 MB')).toBeInTheDocument()
    expect(screen.getAllByText('ready to activate')).toHaveLength(1)
    expect(screen.getByText('prepare failed: disk full')).toBeInTheDocument()
    expect(screen.getByText('preparing…')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText(/1m 5s \/ 2m 10s/)).toBeInTheDocument()
    // The active database can never be deleted from here.
    expect(row('poc').getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it.each([
    ['fresh', 'Prepare', 'POST', '/databases/fresh/prepare', /Preparing "fresh"/],
    ['broken', 'Prepare', 'POST', '/databases/broken/prepare', /Preparing "broken"/],
    ['staging', 'Activate', 'POST', '/databases/staging/activate', /Activated "staging"/],
    [
      'staging',
      'Discard',
      'DELETE',
      '/databases/staging/prepare',
      /Discarded the prepared standby for "staging"/,
    ],
    ['fresh', 'Delete', 'DELETE', '/databases/fresh', /Database "fresh" deleted/],
  ])('%s → %s sends %s %s', async (name, button, method, path, notice) => {
    stubServer()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await loaded()
    fireEvent.click(row(name).getByRole('button', { name: button }))
    expect(await screen.findByText(notice)).toBeInTheDocument()
    expect(calls).toContainEqual(
      expect.objectContaining({ method, url: `/api/v1/database-management${path}` }),
    )
  })

  it('does nothing when the delete is not confirmed', async () => {
    stubServer()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await loaded()
    const before = calls.length
    fireEvent.click(row('fresh').getByRole('button', { name: 'Delete' }))
    expect(calls).toHaveLength(before)
  })

  it.each([
    ['Extract (SQL)', 'false'],
    ['Extract (SQL+S3)', 'true'],
  ])('%s downloads the zip', async (button, includeS3) => {
    stubServer()
    const createObjectURL = vi.fn(() => 'blob:x')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    await loaded()
    fireEvent.click(row('fresh').getByRole('button', { name: button }))
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:x'))
    expect(calls).toContainEqual(
      expect.objectContaining({
        url: `/api/v1/database-management/databases/fresh/extract?include_s3=${includeS3}`,
      }),
    )
  })

  it('restores an uploaded zip into a new database', async () => {
    stubServer()
    await loaded()
    fireEvent.change(screen.getByLabelText(/new database name/i), { target: { value: 'restored' } })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['zip'], 'backup.zip', { type: 'application/zip' })] },
    })
    expect(screen.getByText('backup.zip')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    expect(await screen.findByText(/Restored into "restored"/)).toBeInTheDocument()
    const restore = calls.find((c) => c.url.endsWith('/databases/restore'))
    expect((restore?.body as FormData).get('name')).toBe('restored')
  })
})
