import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const pushMock = vi.fn()
const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock, refresh: refreshMock }) }))

import { SiteAuthForm } from './SiteAuthForm'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function fill(fields: Record<string, string>) {
  for (const [label, value] of Object.entries(fields)) {
    fireEvent.change(screen.getByLabelText(new RegExp(label, 'i')), { target: { value } })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  pushMock.mockClear()
  refreshMock.mockClear()
})

describe('SiteAuthForm', () => {
  it('login POSTs /api/site-auth/login and navigates to /account', async () => {
    const f = vi.fn(async () => json(200, { identity: {} }))
    vi.stubGlobal('fetch', f)
    render(<SiteAuthForm mode="login" />)
    fill({ email: 'v@x.fr', password: 'secret123' })
    fireEvent.click(screen.getByRole('button', { name: /log in/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/account'))
    expect(refreshMock).toHaveBeenCalled()
    expect(f).toHaveBeenCalledWith('/api/site-auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'v@x.fr', password: 'secret123' }),
    }))
  })

  it.each([
    ['/\t/evil.com', '/account'],
    ['/\n/evil.com', '/account'],
    ['//evil.com', '/account'],
    ['/\\evil.com', '/account'],
    ['https://evil.com', '/account'],
    ['/app/crm', '/account'],
    ['/app', '/account'],
    ['/account', '/account'],
    ['/products', '/products'],
  ])('login ?next=%j goes to %s (same-site, never the ERP)', async (next, want) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {})))
    render(<SiteAuthForm mode="login" next={next} />)
    fill({ email: 'v@x.fr', password: 'secret123' })
    fireEvent.click(screen.getByRole('button', { name: /log in/i }))
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(want))
  })

  it('a 401 shows the invalid-credentials message and stays put', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { message: 'invalid credentials' } })))
    render(<SiteAuthForm mode="login" />)
    fill({ email: 'v@x.fr', password: 'wrongpass' })
    fireEvent.click(screen.getByRole('button', { name: /log in/i }))

    expect(await screen.findByText('Invalid email or password.')).toBeTruthy()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('signup refuses a password under 8 characters without posting', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    render(<SiteAuthForm mode="signup" />)
    fill({ name: 'Ada', email: 'v@x.fr', password: 'short' })
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }))

    expect(await screen.findByText('Password must be at least 8 characters.')).toBeTruthy()
    expect(f).not.toHaveBeenCalled()
  })

  it('signup POSTs name/email/password to /api/site-auth/signup', async () => {
    const f = vi.fn(async () => json(200, {}))
    vi.stubGlobal('fetch', f)
    render(<SiteAuthForm mode="signup" />)
    fill({ name: 'Ada', email: 'v@x.fr', password: 'longenough' })
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/account'))
    expect(f).toHaveBeenCalledWith('/api/site-auth/signup', expect.objectContaining({
      body: JSON.stringify({ email: 'v@x.fr', password: 'longenough', name: 'Ada' }),
    }))
  })
})
