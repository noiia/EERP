import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSessionStore, type Identity, type ModuleNav } from '@eerp/core-front'

const pathnameMock = vi.fn<() => string>()
const pushMock = vi.fn()
const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}))

import { AppTopBar } from './AppTopBar'

const identity: Identity = { userId: 'ada', tenantId: 't1', roles: [], permissions: [] }

const crmNav: ModuleNav[] = [
  {
    module: 'crm',
    pages: [
      { kind: 'dashboard', label: 'Dashboard', path: '/crm/dashboard' },
      { kind: 'list', label: 'List', path: '/crm/list' },
    ],
  },
]

beforeEach(() => {
  pushMock.mockReset()
  refreshMock.mockReset()
  useSessionStore.getState().setIdentity(identity)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('AppTopBar', () => {
  it('shows the module breadcrumb rooted at the menu', () => {
    pathnameMock.mockReturnValue('/crm/contacts')
    render(<AppTopBar identity={identity} />)

    expect(screen.getByRole('link', { name: /menu/i })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Crm' })).toHaveAttribute('href', '/crm')
    // The current (last) crumb is plain text, not a link.
    expect(screen.queryByRole('link', { name: 'Contacts' })).not.toBeInTheDocument()
    expect(screen.getByText('Contacts')).toBeInTheDocument()
  })

  it('shows the current module main pages next to the breadcrumb, marking the active one', () => {
    pathnameMock.mockReturnValue('/crm/list')
    render(<AppTopBar identity={identity} nav={crmNav} />)

    const dashboard = screen.getByRole('link', { name: 'Dashboard' })
    const list = screen.getByRole('link', { name: 'List' })
    expect(dashboard).toHaveAttribute('href', '/crm/dashboard')
    expect(list).toHaveAttribute('href', '/crm/list')
    // The page matching the current path is marked current.
    expect(list).toHaveAttribute('aria-current', 'page')
    expect(dashboard).not.toHaveAttribute('aria-current')
  })

  it('shows no module nav for a route outside the registered modules', () => {
    pathnameMock.mockReturnValue('/settings')
    render(<AppTopBar identity={identity} nav={crmNav} />)
    expect(screen.queryByRole('navigation', { name: /module pages/i })).not.toBeInTheDocument()
  })

  it('is hidden without a session', () => {
    pathnameMock.mockReturnValue('/crm/contacts')
    const { container } = render(<AppTopBar identity={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is hidden on the login page', () => {
    pathnameMock.mockReturnValue('/login')
    const { container } = render(<AppTopBar identity={identity} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('logs out: revokes at the BFF, clears the session mirror, redirects to /login', async () => {
    pathnameMock.mockReturnValue('/crm/contacts')
    render(<AppTopBar identity={identity} />)

    fireEvent.click(screen.getByRole('button', { name: /account menu/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /logout/i }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/login'))
    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/logout', { method: 'POST' })
    expect(useSessionStore.getState().identity).toBeNull()
  })
})
