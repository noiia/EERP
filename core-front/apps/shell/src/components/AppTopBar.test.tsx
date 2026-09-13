import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  moduleRegistry,
  useBreadcrumbStore,
  useRecordLabelStore,
  useSessionStore,
  type Identity,
  type ModuleHeaderMenus,
} from '@eerp/core-front'

// Real module registration (idempotent by name — see ModuleRegistry.register)
// so the breadcrumb's "Configuration (<display name>)" collapse has a real
// displayName to resolve, exactly as the generated discovery manifest would
// register it from module.json's own display_name.
moduleRegistry.register({ name: 'crm', routes: [] }, { displayName: 'CRM' })

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

const crmHeaderMenus: ModuleHeaderMenus[] = [
  {
    module: 'crm',
    menus: [
      {
        name: '/crm/dashboard',
        label: 'Dashboard',
        entries: [{ kind: 'line', label: 'Dashboard', path: '/crm/dashboard' }],
      },
      {
        name: '/crm/list',
        label: 'List',
        entries: [{ kind: 'line', label: 'List', path: '/crm/list' }],
      },
      {
        name: 'configuration',
        label: 'Configuration',
        entries: [{ kind: 'line', label: 'Settings', path: '/settings/apps/crm' }],
      },
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
  useBreadcrumbStore.setState({ trail: [] })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  )
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

  it("shows the record's real name on a form route once record-label-store reports it, instead of the raw id", () => {
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

  it('merges the view name and "List" into one crumb ("Crm - List") before a flat "/<module>/<id>" form route (CRM\'s shape: form is a sibling of list, not nested under it)', () => {
    pathnameMock.mockReturnValue('/crm/42')
    render(
      <AppTopBar identity={identity} headerMenus={crmHeaderMenus} knownPaths={['/crm/list']} />,
    )

    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    const listLink = breadcrumb.getByRole('link', { name: 'Crm - List' })
    expect(listLink).toHaveAttribute('href', '/crm/list')
    // Order: Menu > "Crm - List" > 42 — no separate dead "/crm" link.
    expect(breadcrumb.queryByRole('link', { name: 'Crm' })).not.toBeInTheDocument()
    expect(breadcrumb.getByText('42')).toBeInTheDocument()
  })

  it('generalizes to ANY depth — sale\'s quote form ("/sale/quote/:id") merges "Quote" and "List" into one crumb, fixing the dead "/sale/quote" link', () => {
    pathnameMock.mockReturnValue('/sale/quote/99')
    render(<AppTopBar identity={identity} knownPaths={['/sale/list', '/sale/quote/list']} />)

    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    // "Sale" itself must NOT also get a spurious merge from the sibling
    // "/sale/list" — only "Quote"'s own immediate parent ("/sale/quote")
    // matches, so exactly one merged crumb appears: Menu > Sale > Quote -
    // List > 99 (only 4 total crumbs including Menu, so nothing collapses).
    expect(breadcrumb.getByRole('link', { name: 'Sale' })).toHaveAttribute('href', '/sale')
    expect(breadcrumb.getByRole('link', { name: 'Quote - List' })).toHaveAttribute(
      'href',
      '/sale/quote/list',
    )
    expect(breadcrumb.queryByText('Quote', { exact: true })).not.toBeInTheDocument()
    expect(breadcrumb.getByText('99')).toBeInTheDocument()
  })

  it('generalizes to ANY depth without collapsing, when short enough to fit', () => {
    // Same shape as above, but without the module prefix (3 total crumbs:
    // Menu, "Quote - List", 99) — under maxItems, so nothing collapses.
    pathnameMock.mockReturnValue('/quote/99')
    render(<AppTopBar identity={identity} knownPaths={['/quote/list']} />)

    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.getByRole('link', { name: 'Menu' })).toBeInTheDocument()
    expect(breadcrumb.getByRole('link', { name: 'Quote - List' })).toHaveAttribute(
      'href',
      '/quote/list',
    )
    expect(breadcrumb.getByText('99')).toBeInTheDocument()
  })

  it('merges the view name and "List" into one crumb when already on the list page itself', () => {
    pathnameMock.mockReturnValue('/crm/list')
    render(
      <AppTopBar identity={identity} headerMenus={crmHeaderMenus} knownPaths={['/crm/list']} />,
    )
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    // The trailing crumb is the plain-text current page — one merged crumb,
    // not a link, and not two separate "Crm"/"List" crumbs.
    expect(breadcrumb.queryByRole('link', { name: /crm|list/i })).not.toBeInTheDocument()
    expect(breadcrumb.getByText('Crm - List')).toBeInTheDocument()
  })

  it('nested shape: "/sale/quote/list" reads as "Sale > Quote - List", not "Sale > Quote > List"', () => {
    pathnameMock.mockReturnValue('/sale/quote/list')
    render(<AppTopBar identity={identity} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.getByRole('link', { name: 'Sale' })).toHaveAttribute('href', '/sale')
    expect(breadcrumb.queryByRole('link', { name: 'Quote' })).not.toBeInTheDocument()
    expect(breadcrumb.queryByText('Quote', { exact: true })).not.toBeInTheDocument()
    expect(breadcrumb.getByText('Quote - List')).toBeInTheDocument()
  })

  it('does not merge a "List" crumb when no sibling list page is registered', () => {
    pathnameMock.mockReturnValue('/appstore/42')
    render(<AppTopBar identity={identity} headerMenus={[]} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.queryByText('List', { exact: false })).not.toBeInTheDocument()
  })

  it('does not merge a "List" crumb for a path deeper than "/<module>/<id>" when no matching sibling is registered', () => {
    pathnameMock.mockReturnValue('/crm/nested/42')
    render(
      <AppTopBar identity={identity} headerMenus={crmHeaderMenus} knownPaths={['/crm/list']} />,
    )
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.queryByText('List', { exact: false })).not.toBeInTheDocument()
  })

  it('collapses older crumbs under a single "…" once there are more than fit, leaving "… > parent > current"', () => {
    // A synthetic extra nesting level ("orders") keeps this at 5 total crumbs
    // (Menu, Sale, Orders, "Quote - List", 99) even after the view-name/List
    // merge removes one — otherwise 4 total would no longer exceed maxItems.
    pathnameMock.mockReturnValue('/sale/orders/quote/99')
    render(<AppTopBar identity={identity} knownPaths={['/sale/orders/quote/list']} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.queryByRole('link', { name: 'Menu' })).not.toBeInTheDocument()
    expect(breadcrumb.queryByText('Sale')).not.toBeInTheDocument()
    expect(breadcrumb.queryByText('Orders')).not.toBeInTheDocument()
    expect(breadcrumb.getByRole('link', { name: 'Quote - List' })).toHaveAttribute(
      'href',
      '/sale/orders/quote/list',
    )
    expect(breadcrumb.getByText('99')).toBeInTheDocument()
  })

  describe('narrow-phone breadcrumb collapse (below layout.breadcrumbCollapseWidth)', () => {
    const realMatchMedia = window.matchMedia
    beforeEach(() => {
      // Simulate every media query matching (i.e. "narrow") — AppTopBar only ever
      // queries the one breadcrumbCollapseWidth breakpoint, so a single stub covers it.
      window.matchMedia = ((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia
    })
    afterEach(() => {
      window.matchMedia = realMatchMedia
    })

    it('collapses to a "…" summary button plus only the current page', () => {
      pathnameMock.mockReturnValue('/crm/contacts')
      render(<AppTopBar identity={identity} />)

      expect(screen.getByRole('button', { name: /breadcrumb trail/i })).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /menu/i })).not.toBeInTheDocument()
      expect(screen.queryByText('Crm')).not.toBeInTheDocument()
      expect(screen.getByText('Contacts')).toBeInTheDocument()
    })

    it('never collapses the bare root — nothing to summarize on the menu page itself', () => {
      pathnameMock.mockReturnValue('/')
      render(<AppTopBar identity={identity} />)

      expect(screen.queryByRole('button', { name: /breadcrumb trail/i })).not.toBeInTheDocument()
      expect(screen.getByText('Menu')).toBeInTheDocument()
    })

    it('clicking the summary button lists every crumb as a VERTICAL menu, current page non-clickable', () => {
      pathnameMock.mockReturnValue('/crm/contacts')
      render(<AppTopBar identity={identity} />)
      fireEvent.click(screen.getByRole('button', { name: /breadcrumb trail/i }))

      expect(screen.getByRole('menuitem', { name: 'Menu' })).toHaveAttribute('href', '/')
      expect(screen.getByRole('menuitem', { name: 'Crm' })).toHaveAttribute('href', '/crm')
      const current = screen.getByRole('menuitem', { name: 'Contacts' })
      expect(current).not.toHaveAttribute('href')
    })
  })

  it('remembers the prior app when navigating into an unrelated section, appending rather than replacing', () => {
    pathnameMock.mockReturnValue('/sale')
    const { rerender } = render(<AppTopBar identity={identity} />)

    // Jump to Settings — an unrelated section, not a child of /sale.
    pathnameMock.mockReturnValue('/settings')
    rerender(<AppTopBar identity={identity} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    // The prior "Sale" crumb is still there (now clickable), with the new
    // "Settings" page appended as the current (non-link) crumb.
    expect(breadcrumb.getByRole('link', { name: 'Sale' })).toHaveAttribute('href', '/sale')
    expect(breadcrumb.getByText('Settings')).toBeInTheDocument()
    expect(breadcrumb.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('clicking an earlier crumb truncates the forward history instead of leaving it dangling', () => {
    pathnameMock.mockReturnValue('/sale')
    const { rerender } = render(<AppTopBar identity={identity} />)

    pathnameMock.mockReturnValue('/settings')
    rerender(<AppTopBar identity={identity} />)

    // Simulate following the "Sale" crumb back — the pathname returns to a
    // page already in the trail, so it should truncate rather than append.
    pathnameMock.mockReturnValue('/sale')
    rerender(<AppTopBar identity={identity} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.queryByText('Settings')).not.toBeInTheDocument()
    expect(breadcrumb.getByText('Sale')).toBeInTheDocument()
  })

  it('collapses "/settings/apps/:module" to one "Configuration (<display name>)" crumb instead of the full Settings > Apps > Crm path', () => {
    pathnameMock.mockReturnValue('/settings/apps/crm')
    render(<AppTopBar identity={identity} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))

    expect(breadcrumb.getByText('Configuration (CRM)')).toBeInTheDocument()
    expect(breadcrumb.queryByText('Settings')).not.toBeInTheDocument()
    expect(breadcrumb.queryByText('Apps')).not.toBeInTheDocument()
    expect(breadcrumb.queryByText('Crm')).not.toBeInTheDocument()
  })

  it('falls back to a titleized module slug in the collapsed Configuration crumb when the module has no registered display name', () => {
    pathnameMock.mockReturnValue('/settings/apps/unregisteredmod')
    render(<AppTopBar identity={identity} />)
    expect(
      within(screen.getByRole('navigation', { name: 'breadcrumb' })).getByText(
        'Configuration (Unregisteredmod)',
      ),
    ).toBeInTheDocument()
  })

  it("keeps a record's resolved display name once the user navigates away from its form, instead of falling back to the raw id", () => {
    pathnameMock.mockReturnValue('/crm/42')
    useRecordLabelStore.getState().setLabel('42', 'Widget Co')
    const { rerender } = render(<AppTopBar identity={identity} />)

    pathnameMock.mockReturnValue('/settings')
    rerender(<AppTopBar identity={identity} />)

    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.getByRole('link', { name: 'Widget Co' })).toHaveAttribute('href', '/crm/42')
    expect(breadcrumb.queryByText('42')).not.toBeInTheDocument()
  })

  it('labels the /settings/appearance crumb "Global settings", not the titleized "Appearance" slug', () => {
    pathnameMock.mockReturnValue('/settings/appearance')
    render(<AppTopBar identity={identity} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.getByText('Global settings')).toBeInTheDocument()
    expect(breadcrumb.queryByText('Appearance')).not.toBeInTheDocument()
  })

  it('labels the /propertymanagement crumb "Property Management - List", not the titleized "Propertymanagement" slug', () => {
    pathnameMock.mockReturnValue('/propertymanagement/list')
    render(<AppTopBar identity={identity} />)
    const breadcrumb = within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    expect(breadcrumb.getByText('Property Management - List')).toBeInTheDocument()
    expect(breadcrumb.queryByText('Propertymanagement', { exact: false })).not.toBeInTheDocument()
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

  it('shows the current module header menus next to the breadcrumb, each navigable', () => {
    pathnameMock.mockReturnValue('/crm/list')
    render(<AppTopBar identity={identity} headerMenus={crmHeaderMenus} />)

    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'List' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Configuration' })).toBeInTheDocument()

    // A single-line menu (Dashboard/List here) navigates straight from the
    // button — no dropdown for a list of exactly one item.
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(pushMock).toHaveBeenCalledWith('/crm/list')
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

  it('shows no header menu buttons for a route outside the registered modules', () => {
    // The "module pages" nav landmark still renders (it doubles as the
    // Toolbar's flex-grow spacer, keeping CompanySwitcher/UserMenu pinned
    // right even off a module route) but stays empty — no header menus.
    pathnameMock.mockReturnValue('/settings')
    render(<AppTopBar identity={identity} headerMenus={crmHeaderMenus} />)
    const nav = screen.getByRole('navigation', { name: /module pages/i })
    expect(nav).toBeEmptyDOMElement()
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
