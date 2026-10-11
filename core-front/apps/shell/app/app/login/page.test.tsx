import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const pushMock = vi.fn()
const refreshMock = vi.fn()
let search = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => new URLSearchParams(search),
}))

import LoginScreen from './LoginScreen'
import type { LoginMethod, LoginMethods } from '@/lib/auth-methods'

const local: LoginMethod = { id: 'local', kind: 'password', label: '' }
const ldap: LoginMethod = { id: 'ldap', kind: 'password', label: 'Company directory' }
const corp: LoginMethod = { id: 'oidc:corp', kind: 'redirect', label: 'Authentik' }
const google: LoginMethod = { id: 'oidc:google', kind: 'redirect', label: 'Google' }
const methods = (d: LoginMethod, alternatives: LoginMethod[] = []): LoginMethods => ({
  default: d,
  alternatives,
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fillAndSubmit(userLabel: RegExp) {
  fireEvent.change(screen.getByLabelText(userLabel), { target: { value: 'a@b.c' } })
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  pushMock.mockClear()
  refreshMock.mockClear()
  search = ''
})

describe('LoginScreen local', () => {
  it('shows the server error message on bad credentials and does not redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: { message: 'Invalid email or password.' } })),
    )
    render(<LoginScreen methods={methods(local)} />)
    fillAndSubmit(/email/i)

    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('posts {email, password} and redirects on success', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { identity: { userId: 'u1', tenantId: 't1', roles: [], permissions: [] } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<LoginScreen methods={methods(local)} />)
    fillAndSubmit(/email/i)

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/app'))
    expect(refreshMock).toHaveBeenCalled()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.c', password: 'pw' })
  })
})

describe('LoginScreen methods', () => {
  it('ldap default posts {username, password} to /api/auth/ldap and shows Go message on 401', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { error: { message: 'Invalid username or password.' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<LoginScreen methods={methods(ldap)} />)
    expect(screen.getByText('Company directory')).toBeInTheDocument()
    fillAndSubmit(/username/i)

    expect(await screen.findByText('Invalid username or password.')).toBeInTheDocument()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/auth/ldap')
    expect(JSON.parse(init.body as string)).toEqual({ username: 'a@b.c', password: 'pw' })
  })

  it('oidc default renders a continue link and no password field', () => {
    search = 'next=%2Fcontacts'
    render(<LoginScreen methods={methods(corp)} />)
    expect(screen.getByRole('link', { name: /continue with authentik/i })).toHaveAttribute(
      'href',
      '/api/auth/oidc/corp/start?next=%2Fcontacts',
    )
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
  })

  it('renders redirect alternatives under an "or" divider', () => {
    render(<LoginScreen methods={methods(local, [google])} />)
    expect(screen.getByText('or')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /continue with google/i })).toBeInTheDocument()
  })

  it('a local alternative swaps the top form to local', () => {
    render(<LoginScreen methods={methods(ldap, [local])} />)
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /sign in with email and password/i }))
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
  })

  it('?method=local puts the local form on top even when the default is oidc', () => {
    search = 'method=local'
    render(<LoginScreen methods={methods(corp, [local])} />)
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
  })

  it('?error=sso shows the SSO error alert', () => {
    search = 'error=sso'
    render(<LoginScreen methods={methods(local)} />)
    expect(
      screen.getByText('Single sign-on failed. Try again or use another method.'),
    ).toBeInTheDocument()
  })
})
