import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppHeaderMenuBar, HeaderMenuButton } from './header-menu-bar'
import type { HeaderMenu } from './header-menu-registry'
import { useSessionStore, type Identity } from './session-store'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

// Defaults to a wide, non-collapsing container — RTL's own cleanup can
// trigger a stray re-render after a test's `afterEach` already ran, and a
// mock reset to `undefined` would crash that render's destructure.
const useContainerWidthMock = vi.fn(() => ({
  width: 1000,
  containerRef: { current: null },
  mounted: true,
}))
vi.mock('react-grid-layout', () => ({
  useContainerWidth: () => useContainerWidthMock(),
}))

function setIdentity(permissions: string[]) {
  const identity: Identity = { userId: 'u1', tenantId: 't1', roles: [], permissions }
  useSessionStore.getState().setIdentity(identity)
}

afterEach(() => {
  pushMock.mockClear()
  useContainerWidthMock.mockClear()
  useSessionStore.getState().clear()
})

const productsMenu: HeaderMenu = {
  name: '/sale/products',
  label: 'Products',
  entries: [{ kind: 'line', label: 'Products', path: '/sale/products' }],
}

const configurationMenu: HeaderMenu = {
  name: 'configuration',
  label: 'Configuration',
  entries: [
    { kind: 'line', label: 'Settings', path: '/settings/apps/sale' },
    {
      kind: 'group',
      label: 'Finance',
      children: [
        { kind: 'line', label: 'Taxes', path: '/sale/taxes' },
        {
          kind: 'line',
          label: 'Currencies',
          path: '/sale/currencies',
          permission: 'currency:currency:read',
        },
      ],
    },
  ],
}

describe('HeaderMenuButton', () => {
  it('navigates directly on click for a single-line menu — no dropdown for a list of one', () => {
    setIdentity([])
    render(<HeaderMenuButton menu={productsMenu} />)
    const button = screen.getByRole('button', { name: 'Products' })
    expect(button).not.toHaveAttribute('aria-haspopup')
    fireEvent.click(button)
    expect(pushMock).toHaveBeenCalledWith('/sale/products')
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('opens its dropdown on click and navigates on a line click, for a multi-entry menu', () => {
    setIdentity([])
    render(<HeaderMenuButton menu={configurationMenu} />)
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(pushMock).toHaveBeenCalledWith('/settings/apps/sale')
  })

  it('renders a group as a labeled cluster of its own lines', () => {
    setIdentity([])
    render(<HeaderMenuButton menu={configurationMenu} />)
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))
    expect(screen.getByText('Finance')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Taxes' })).toBeInTheDocument()
  })

  it('hides a permission-gated line the caller cannot use', () => {
    setIdentity([])
    render(<HeaderMenuButton menu={configurationMenu} />)
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))
    expect(screen.queryByRole('menuitem', { name: 'Currencies' })).not.toBeInTheDocument()
  })

  it('shows a permission-gated line once the caller has it', () => {
    setIdentity(['currency:currency:read'])
    render(<HeaderMenuButton menu={configurationMenu} />)
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))
    expect(screen.getByRole('menuitem', { name: 'Currencies' })).toBeInTheDocument()
  })

  it('renders nothing once every entry is permission-denied', () => {
    setIdentity([])
    const { container } = render(
      <HeaderMenuButton
        menu={{
          name: 'x',
          label: 'X',
          entries: [{ kind: 'line', label: 'X', path: '/x', permission: 'x:x:read' }],
        }}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('AppHeaderMenuBar', () => {
  it('renders one button per menu, side by side, when everything fits', () => {
    setIdentity([])
    useContainerWidthMock.mockReturnValue({
      width: 1000,
      containerRef: { current: null },
      mounted: true,
    })
    render(<AppHeaderMenuBar menus={[productsMenu, configurationMenu]} />)
    expect(screen.getByRole('button', { name: 'Products' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Configuration' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'App menus' })).not.toBeInTheDocument()
  })

  it('renders nothing once every menu is permission-denied', () => {
    setIdentity([])
    useContainerWidthMock.mockReturnValue({
      width: 1000,
      containerRef: { current: null },
      mounted: true,
    })
    const { container } = render(
      <AppHeaderMenuBar
        menus={[
          {
            name: 'x',
            label: 'X',
            entries: [{ kind: 'line', label: 'X', path: '/x', permission: 'x:x:read' }],
          },
        ]}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  // Forces the collapsed (icon + drill-down Menu) rendering — see the probe/
  // scrollWidth comment inside the test below for why this needs a rerender.
  function collapse(container: HTMLElement, menus: HeaderMenu[]) {
    const probe = container.querySelector('[data-testid="header-menu-probe"]') as HTMLElement
    Object.defineProperty(probe, 'scrollWidth', { value: 2000, configurable: true })
    useContainerWidthMock.mockReturnValue({
      width: 500,
      containerRef: { current: null },
      mounted: true,
    })
  }

  it('collapses to a single icon once the row does not fit', async () => {
    setIdentity([])
    useContainerWidthMock.mockReturnValue({
      width: 1000,
      containerRef: { current: null },
      mounted: true,
    })
    const { container, rerender } = render(
      <AppHeaderMenuBar menus={[productsMenu, configurationMenu]} />,
    )

    // Force the probe wider than the (new, smaller) measured container so
    // the next layout-effect run detects overflow — jsdom reports 0 for both
    // scrollWidth and the measured width by default, so this simulates a
    // narrow top bar without a real ResizeObserver.
    collapse(container, [productsMenu, configurationMenu])
    rerender(<AppHeaderMenuBar menus={[productsMenu, configurationMenu]} />)

    await screen.findByRole('button', { name: 'App menus' })
    expect(screen.queryByRole('button', { name: 'Products' })).not.toBeInTheDocument()
  })

  it('picking a lonely-line menu from the overview navigates directly — no one-item drilldown', async () => {
    setIdentity([])
    useContainerWidthMock.mockReturnValue({
      width: 1000,
      containerRef: { current: null },
      mounted: true,
    })
    const { container, rerender } = render(
      <AppHeaderMenuBar menus={[productsMenu, configurationMenu]} />,
    )
    collapse(container, [productsMenu, configurationMenu])
    rerender(<AppHeaderMenuBar menus={[productsMenu, configurationMenu]} />)

    fireEvent.click(await screen.findByRole('button', { name: 'App menus' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Products' }))

    expect(pushMock).toHaveBeenCalledWith('/sale/products')
    // The menu closed straight to navigation — no lingering "Back" line from
    // a drilldown that was never entered.
    expect(screen.queryByRole('menuitem', { name: 'Back' })).not.toBeInTheDocument()
  })

  it('picking a multi-entry menu from the overview drills into its own entries, with a Back line to return', async () => {
    setIdentity([])
    useContainerWidthMock.mockReturnValue({
      width: 1000,
      containerRef: { current: null },
      mounted: true,
    })
    const { container, rerender } = render(
      <AppHeaderMenuBar menus={[productsMenu, configurationMenu]} />,
    )
    collapse(container, [productsMenu, configurationMenu])
    rerender(<AppHeaderMenuBar menus={[productsMenu, configurationMenu]} />)

    fireEvent.click(await screen.findByRole('button', { name: 'App menus' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Configuration' }))

    // Drilldown: Configuration's own entries render, with a Back line above
    // them — the overview's "Products"/"Configuration" titles are gone,
    // replaced entirely (one Menu, swapped content), not a second panel.
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument())
    expect(screen.getByRole('menuitem', { name: 'Back' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Products' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(pushMock).toHaveBeenCalledWith('/settings/apps/sale')
  })

  it('the Back line returns to the overview without navigating', async () => {
    setIdentity([])
    useContainerWidthMock.mockReturnValue({
      width: 1000,
      containerRef: { current: null },
      mounted: true,
    })
    const { container, rerender } = render(
      <AppHeaderMenuBar menus={[productsMenu, configurationMenu]} />,
    )
    collapse(container, [productsMenu, configurationMenu])
    rerender(<AppHeaderMenuBar menus={[productsMenu, configurationMenu]} />)

    fireEvent.click(await screen.findByRole('button', { name: 'App menus' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Configuration' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Back' }))

    expect(await screen.findByRole('menuitem', { name: 'Products' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Configuration' })).toBeInTheDocument()
    expect(pushMock).not.toHaveBeenCalled()
  })
})
