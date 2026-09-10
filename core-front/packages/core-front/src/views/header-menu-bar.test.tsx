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
  it('opens its dropdown on click and navigates on a line click', () => {
    setIdentity([])
    render(<HeaderMenuButton menu={productsMenu} />)
    fireEvent.click(screen.getByRole('button', { name: 'Products' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Products' }))
    expect(pushMock).toHaveBeenCalledWith('/sale/products')
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

  it('collapses to a single icon once the row does not fit, and drills into a menu with the previous list rendered as a rail', async () => {
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
    const probe = container.querySelector('[data-testid="header-menu-probe"]') as HTMLElement
    Object.defineProperty(probe, 'scrollWidth', { value: 2000, configurable: true })
    useContainerWidthMock.mockReturnValue({
      width: 500,
      containerRef: { current: null },
      mounted: true,
    })
    rerender(<AppHeaderMenuBar menus={[productsMenu, configurationMenu]} />)

    const icon = await screen.findByRole('button', { name: 'App menus' })
    expect(screen.queryByRole('button', { name: 'Products' })).not.toBeInTheDocument()

    fireEvent.click(icon)
    const productsTitle = await screen.findByRole('menuitem', { name: 'Products' })
    fireEvent.click(productsTitle)

    // Drilldown: the selected menu's own line renders (centered panel)...
    await waitFor(() =>
      expect(screen.getAllByRole('menuitem', { name: 'Products' })).toHaveLength(2),
    )
    // ...and the title list is still there (now the left rail), Configuration included.
    expect(screen.getByRole('menuitem', { name: 'Configuration' })).toBeInTheDocument()
  })
})
