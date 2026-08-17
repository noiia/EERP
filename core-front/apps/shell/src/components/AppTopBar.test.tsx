import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRecordLabelStore, useSessionStore, type Identity, type ModuleNav } from '@eerp/core-front'

const pathnameMock = vi.fn<() => string>()
const pushMock = vi.fn()
const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}))

const setActiveCompanyMock = vi.fn()
vi.mock('@/lib/company', () => ({
  setActiveCompany: (companyId: string) => setActiveCompanyMock(companyId),
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
  setActiveCompanyMock.mockReset()
  setActiveCompanyMock.mockResolvedValue({ ok: true })
  useSessionStore.getState().setIdentity(identity)
  useRecordLabelStore.setState({ id: null, label: null })
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

  it('shows the record\'s real name on a form route once record-label-store reports it, instead of the raw id', () => {
    pathnameMock.mockReturnValue('/crm/contacts/3fa85f64-5717-4562-b3fc-2c963f66afa6')
    useRecordLabelStore.getState().setLabel('3fa85f64-5717-4562-b3fc-2c963f66afa6', 'Ada Lovelace')
    render(<AppTopBar identity={identity} />)

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.queryByText('3fa85f64-5717-4562-b3fc-2c963f66afa6')).not.toBeInTheDocument()
  })

  it('falls back to the titleized (garbled) id segment when record-label-store has no matching entry yet', () => {
    pathnameMock.mockReturnValue('/crm/contacts/3fa85f64-5717-4562-b3fc-2c963f66afa6')
    render(<AppTopBar identity={identity} />)

    // The exact bug being fixed: with no record-label-store entry, the raw uuid
    // segment gets run through the crumb titleizer and comes out garbled.
    expect(screen.getByText('3fa85f64 5717 4562 B3fc 2c963f66afa6')).toBeInTheDocument()
  })

  it('ignores a stale record-label-store entry left over from a different record', () => {
    pathnameMock.mockReturnValue('/crm/contacts/new-record-id')
    useRecordLabelStore.getState().setLabel('some-other-id', 'Stale Name')
    render(<AppTopBar identity={identity} />)

    expect(screen.queryByText('Stale Name')).not.toBeInTheDocument()
    expect(screen.getByText('New Record Id')).toBeInTheDocument()
  })

  it('inserts a "List" crumb before a flat "/<module>/<id>" form route (CRM\'s shape: form is a sibling of list, not nested under it)', () => {
    pathnameMock.mockReturnValue('/crm/42')
    render(<AppTopBar identity={identity} nav={crmNav} knownPaths={['/crm/list']} />)

    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    const listLink = breadcrumb.getByRole('link', { name: 'List' })
    expect(listLink).toHaveAttribute('href', '/crm/list')
    // Order: Menu > Crm > List > 42, with List sitting between the module and the record.
    const crumbTexts = breadcrumb.getAllByText(/^(Crm|List|42)$/).map((el) => el.textContent)
    expect(crumbTexts).toEqual(['Crm', 'List', '42'])
  })

  it('generalizes to ANY depth — sale\'s quote form ("/sale/quote/:id") splices List between Quote and the record, fixing the dead "/sale/quote" link', () => {
    pathnameMock.mockReturnValue('/sale/quote/99')
    render(<AppTopBar identity={identity} knownPaths={['/sale/list', '/sale/quote/list']} />)

    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    // "Sale" itself must NOT also get a spurious splice from the sibling
    // "/sale/list" — only "Quote"'s own immediate parent ("/sale/quote")
    // matches, so exactly one "List" crumb appears (5 total crumbs also
    // triggers the collapse — see the dedicated test below — which is WHY
    // Sale/Quote themselves aren't asserted visible here).
    expect(breadcrumb.getAllByText('List')).toHaveLength(1)
    expect(breadcrumb.getByRole('link', { name: 'List' })).toHaveAttribute('href', '/sale/quote/list')
    expect(breadcrumb.getByText('99')).toBeInTheDocument()
  })

  it('generalizes to ANY depth without collapsing, when short enough to fit', () => {
    // Same shape as above, but with 4 total crumbs (Menu, Quote, List, 99)
    // instead of 5 — under maxItems, so nothing collapses and the full
    // chain (module segment omitted here on purpose) is visible.
    pathnameMock.mockReturnValue('/quote/99')
    render(<AppTopBar identity={identity} knownPaths={['/quote/list']} />)

    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.getByRole('link', { name: 'Menu' })).toBeInTheDocument()
    const crumbTexts = breadcrumb.getAllByText(/^(Quote|List|99)$/).map((el) => el.textContent)
    expect(crumbTexts).toEqual(['Quote', 'List', '99'])
    expect(breadcrumb.getByRole('link', { name: 'Quote' })).toHaveAttribute('href', '/quote')
    expect(breadcrumb.getByRole('link', { name: 'List' })).toHaveAttribute('href', '/quote/list')
  })

  it('does not insert a "List" crumb when already on the list page itself', () => {
    pathnameMock.mockReturnValue('/crm/list')
    render(<AppTopBar identity={identity} nav={crmNav} knownPaths={['/crm/list']} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    // The trailing crumb is the plain-text current page, not a second "List" link.
    expect(breadcrumb.queryByRole('link', { name: 'List' })).not.toBeInTheDocument()
    expect(breadcrumb.getByText('List')).toBeInTheDocument()
  })

  it('does not insert a "List" crumb when no sibling list page is registered', () => {
    pathnameMock.mockReturnValue('/appstore/42')
    render(<AppTopBar identity={identity} nav={[]} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.queryByText('List')).not.toBeInTheDocument()
  })

  it('does not insert a "List" crumb for a path deeper than "/<module>/<id>" when no matching sibling is registered', () => {
    pathnameMock.mockReturnValue('/crm/nested/42')
    render(<AppTopBar identity={identity} nav={crmNav} knownPaths={['/crm/list']} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.queryByRole('link', { name: 'List' })).not.toBeInTheDocument()
  })

  it('collapses older crumbs under a single "…" once there are more than fit, leaving "… > parent > current"', () => {
    pathnameMock.mockReturnValue('/sale/quote/99')
    render(<AppTopBar identity={identity} knownPaths={['/sale/quote/list']} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    // 5 items (Menu, Sale, Quote, List, 99) exceed maxItems=4 — collapses to
    // an ellipsis (even swallowing the root "Menu" crumb) plus the last two.
    expect(breadcrumb.queryByRole('link', { name: 'Menu' })).not.toBeInTheDocument()
    expect(breadcrumb.queryByText('Sale')).not.toBeInTheDocument()
    expect(breadcrumb.queryByText('Quote')).not.toBeInTheDocument()
    expect(breadcrumb.getByRole('link', { name: 'List' })).toHaveAttribute('href', '/sale/quote/list')
    expect(breadcrumb.getByText('99')).toBeInTheDocument()
  })

  it('labels the /settings/appearance crumb "Global settings", not the titleized "Appearance" slug', () => {
    pathnameMock.mockReturnValue('/settings/appearance')
    render(<AppTopBar identity={identity} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.getByText('Global settings')).toBeInTheDocument()
    expect(breadcrumb.queryByText('Appearance')).not.toBeInTheDocument()
  })

  it('labels the /propertymanagement crumb "Property Management", not the titleized "Propertymanagement" slug', () => {
    pathnameMock.mockReturnValue('/propertymanagement/list')
    render(<AppTopBar identity={identity} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.getByText('Property Management')).toBeInTheDocument()
    expect(breadcrumb.queryByText('Propertymanagement')).not.toBeInTheDocument()
  })

  it('omits the "page-formats" segment from a page format\'s breadcrumb (no page of its own — the list is embedded in Global settings)', () => {
    pathnameMock.mockReturnValue('/settings/appearance/page-formats/42')
    render(<AppTopBar identity={identity} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))

    expect(breadcrumb.getByRole('link', { name: 'Global settings' })).toHaveAttribute(
      'href',
      '/settings/appearance',
    )
    expect(breadcrumb.queryByText('Page Formats')).not.toBeInTheDocument()
    expect(breadcrumb.queryByText(/page.?formats/i)).not.toBeInTheDocument()
    // Trailing crumb is still the record (raw id, absent a record-label-store entry).
    expect(breadcrumb.getByText('42')).toBeInTheDocument()
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

  const acme = { id: 'co-1', name: 'Acme Corp' }
  const globex = { id: 'co-2', name: 'Globex' }

  it('shows the active company name as a button, not a plain link', () => {
    pathnameMock.mockReturnValue('/crm/contacts')
    render(<AppTopBar identity={identity} activeCompany={acme} companies={[acme]} />)
    expect(screen.getByRole('button', { name: /acme corp/i })).toBeInTheDocument()
  })

  it('renders no company switcher when the active company is unknown', () => {
    pathnameMock.mockReturnValue('/crm/contacts')
    render(<AppTopBar identity={identity} />)
    expect(screen.queryByRole('button', { name: /acme corp/i })).not.toBeInTheDocument()
  })

  it('opens a menu listing every company, with a link to manage them', () => {
    pathnameMock.mockReturnValue('/crm/contacts')
    render(<AppTopBar identity={identity} activeCompany={acme} companies={[acme, globex]} />)
    fireEvent.click(screen.getByRole('button', { name: /acme corp/i }))

    expect(screen.getByRole('menuitem', { name: 'Acme Corp' })).toHaveClass('Mui-selected')
    expect(screen.getByRole('menuitem', { name: 'Globex' })).not.toHaveClass('Mui-selected')
    const manage = screen.getByRole('menuitem', { name: /manage companies/i })
    expect(manage).toHaveAttribute('href', '/settings/company')
  })

  it('switching to a different company calls setActiveCompany and refreshes', async () => {
    pathnameMock.mockReturnValue('/crm/contacts')
    render(<AppTopBar identity={identity} activeCompany={acme} companies={[acme, globex]} />)
    fireEvent.click(screen.getByRole('button', { name: /acme corp/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Globex' }))

    await waitFor(() => expect(setActiveCompanyMock).toHaveBeenCalledWith('co-2'))
    await waitFor(() => expect(refreshMock).toHaveBeenCalled())
  })

  it('clicking the already-active company is a no-op', async () => {
    pathnameMock.mockReturnValue('/crm/contacts')
    render(<AppTopBar identity={identity} activeCompany={acme} companies={[acme, globex]} />)
    fireEvent.click(screen.getByRole('button', { name: /acme corp/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Acme Corp' }))

    expect(setActiveCompanyMock).not.toHaveBeenCalled()
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

  it('shows the caller\'s email after "Signed in as" — the closest thing to a display name this schema has', () => {
    pathnameMock.mockReturnValue('/crm/contacts')
    render(<AppTopBar identity={identity} email="ada@example.test" />)
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }))
    expect(screen.getByText(/signed in as/i)).toHaveTextContent('Signed in as ada@example.test')
  })

  it('falls back to the raw user id when email has not resolved yet', () => {
    pathnameMock.mockReturnValue('/crm/contacts')
    render(<AppTopBar identity={identity} />)
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }))
    expect(screen.getByText(/signed in as/i)).toHaveTextContent(`Signed in as ${identity.userId}`)
  })
})
