import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import DatabaseManagementPage from './page'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
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
      vi.fn(async () => jsonResponse(401, { error: { message: 'Invalid or missing master key.' } })),
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
