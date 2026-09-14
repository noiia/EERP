import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const pushMock = vi.fn()
const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => new URLSearchParams(''),
}))

import LoginPage from './page'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function fillAndSubmit() {
  // The `required` TextFields render their label as "Email *" / "Password *".
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.c' } })
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

afterEach(() => {
  vi.restoreAllMocks()
  pushMock.mockClear()
  refreshMock.mockClear()
})

describe('LoginPage', () => {
  it('shows the server error message on bad credentials and does not redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: { message: 'Invalid email or password.' } })),
    )
    render(<LoginPage />)
    fillAndSubmit()

    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('redirects to the intended route on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, { identity: { userId: 'u1', tenantId: 't1', roles: [], permissions: [] } }),
      ),
    )
    render(<LoginPage />)
    fillAndSubmit()

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/'))
    // Re-fetches the server tree so the cached root layout picks up the new session cookie.
    expect(refreshMock).toHaveBeenCalled()
  })
})
