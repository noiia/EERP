'use client'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import ListSubheader from '@mui/material/ListSubheader'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import MenuList from '@mui/material/MenuList'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import { useContainerWidth } from 'react-grid-layout'
import { hasPermission } from '../auth/permissions'
import { useT } from '../i18n/translate'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import type { HeaderMenu, HeaderMenuNode } from './header-menu-registry'
import { useSessionStore } from './session-store'

// The Odoo-style per-app top bar: one HeaderMenuButton per menu (see
// ModuleRegistry.headerMenus()), side by side, collapsing to a single icon
// with a two-level drill-down when they don't fit — see AppHeaderMenuBar.

// Stable reference — a fresh [] from the selector would make zustand see a
// new snapshot every render (same guard auth/Can.tsx's usePermission takes).
const NO_PERMISSIONS: string[] = []

// MUI's documented dense-Toolbar height in px — matches AppTopBar.tsx's own
// `<Toolbar variant="dense">`, so the drill-down overlay's `top` sits flush
// under the real bar without measuring it live at runtime.
const TOOLBAR_HEIGHT = 48

/** Filters a menu's entries down to what the caller's permissions allow — a
 * gated line is dropped; a group with no permitted lines left is dropped
 * whole. Display gating only, same posture as every other client-side
 * permission check in this package — the server re-authorizes navigation
 * regardless of what the menu offers to click. */
function permittedEntries(entries: HeaderMenuNode[], permissions: string[]): HeaderMenuNode[] {
  const result: HeaderMenuNode[] = []
  for (const node of entries) {
    if (node.kind === 'line') {
      if (!node.permission || hasPermission(permissions, node.permission)) result.push(node)
      continue
    }
    const children = node.children.filter(
      (c) => !c.permission || hasPermission(permissions, c.permission),
    )
    if (children.length > 0) result.push({ ...node, children })
  }
  return result
}

/** Flattens a menu's entries into MENU-DIRECT children (MenuItem/ListSubheader) — a
 * group's label renders as a non-interactive ListSubheader immediately followed by
 * its own lines, indented; never wrapped in an extra element, since MUI's Menu/
 * MenuList expects a flat child list for its own keyboard-nav/cloning to work. */
function renderMenuEntries(
  entries: HeaderMenuNode[],
  t: (s: string) => string,
  onNavigate: (path: string) => void,
) {
  return entries.flatMap((node) => {
    if (node.kind === 'line') {
      return [
        <MenuItem key={node.path} onClick={() => onNavigate(node.path)}>
          {t(node.label)}
        </MenuItem>,
      ]
    }
    return [
      <ListSubheader
        key={`group:${node.label}`}
        disableSticky
        sx={{ lineHeight: 2.5, color: 'text.secondary' }}
      >
        {t(node.label)}
      </ListSubheader>,
      ...node.children.map((child) => (
        <MenuItem key={child.path} onClick={() => onNavigate(child.path)} sx={{ pl: 3 }}>
          {t(child.label)}
        </MenuItem>
      )),
    ]
  })
}

/** One top-bar menu button — opens its dropdown on click AND on hover (a short
 * close delay so moving from the button into the menu doesn't dismiss it), same
 * "hover intent" shape UserMenu/CompanySwitcher don't need (click-only) but a
 * top menu bar does. Renders nothing once permission-filtering leaves it with
 * no entries at all. */
export function HeaderMenuButton({ menu }: { menu: HeaderMenu }) {
  const t = useT()
  const router = useRouter()
  const permissions = useSessionStore((s) => s.identity?.permissions ?? NO_PERMISSIONS)
  const entries = useMemo(
    () => permittedEntries(menu.entries, permissions),
    [menu.entries, permissions],
  )
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    [],
  )

  if (entries.length === 0) return null

  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }
  function scheduleClose() {
    closeTimer.current = setTimeout(() => setOpen(false), 200)
  }
  function close() {
    setOpen(false)
  }
  function navigate(path: string) {
    close()
    router.push(path)
  }

  function openOnHover() {
    cancelClose()
    setOpen(true)
  }

  return (
    <Box onMouseEnter={openOnHover} onMouseLeave={scheduleClose} sx={{ display: 'inline-flex' }}>
      <Button
        ref={buttonRef}
        color="inherit"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        sx={{ fontWeight: 700, textTransform: 'none', whiteSpace: 'nowrap' }}
      >
        {t(menu.label)}
      </Button>
      <Menu
        anchorEl={buttonRef.current}
        open={open}
        onClose={close}
        disableRestoreFocus
        slotProps={{
          list: { onMouseEnter: cancelClose, onMouseLeave: scheduleClose, dense: true },
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        {renderMenuEntries(entries, t, navigate)}
      </Menu>
    </Box>
  )
}

/** A plain visual stand-in for HeaderMenuButton's own Button, used only inside
 * the invisible measurement probe below — same label/padding/font so its
 * width is representative, none of the real button's interactivity. */
function ButtonProbe({ label }: { label: string }) {
  const t = useT()
  return (
    <Button
      tabIndex={-1}
      color="inherit"
      sx={{ fontWeight: 700, textTransform: 'none', whiteSpace: 'nowrap', pointerEvents: 'none' }}
    >
      {t(label)}
    </Button>
  )
}

/**
 * The current module's full top-bar menu row (see ModuleRegistry.headerMenus()) —
 * every menu side by side ("aside of each other"). Below the row's own measured
 * available width, collapses to a single icon opening a two-level drill-down:
 * clicking it lists every menu's title (overview); picking one renders that
 * menu's own dropdown CENTERED while the title list animates down to a 10vw-wide
 * left rail (drilldown) — clicking the rail again returns to the overview.
 * Renders nothing once permission-filtering leaves no menu with any entries.
 */
export function AppHeaderMenuBar({ menus }: { menus: HeaderMenu[] }) {
  const t = useT()
  const router = useRouter()
  const permissions = useSessionStore((s) => s.identity?.permissions ?? NO_PERMISSIONS)
  const visibleMenus = useMemo(
    () => menus.filter((m) => permittedEntries(m.entries, permissions).length > 0),
    [menus, permissions],
  )

  const {
    width: containerWidth,
    containerRef,
    mounted,
  } = useContainerWidth({ measureBeforeMount: true })
  const probeRef = useRef<HTMLDivElement | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  // The probe stays laid out (absolute + hidden, never display:none — an
  // element with display:none reports scrollWidth 0, which would make a
  // once-collapsed bar unable to ever detect it has room to re-expand) so its
  // scrollWidth always reflects the row's true, unwrapped natural width.
  useLayoutEffect(() => {
    if (!mounted || !probeRef.current) return
    setCollapsed(probeRef.current.scrollWidth > containerWidth)
  }, [mounted, containerWidth, visibleMenus])

  const [phase, setPhase] = useState<'closed' | 'overview' | 'drilldown'>('closed')
  const [selected, setSelected] = useState<HeaderMenu | null>(null)

  useEffect(() => {
    if (phase === 'closed') return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeDrilldown()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  function closeDrilldown() {
    setPhase('closed')
    setSelected(null)
  }
  function navigate(path: string) {
    closeDrilldown()
    router.push(path)
  }

  if (visibleMenus.length === 0) return null

  return (
    <Box
      ref={containerRef}
      sx={{
        position: 'relative',
        flex: '1 1 auto',
        minWidth: 0,
        display: 'flex',
        overflow: 'hidden',
      }}
    >
      {/* Invisible measurement probe — see the comment above. */}
      <Box
        ref={probeRef}
        aria-hidden
        data-testid="header-menu-probe"
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          visibility: 'hidden',
          display: 'flex',
          flexWrap: 'nowrap',
          alignItems: 'center',
          gap: 1,
        }}
      >
        {visibleMenus.map((m) => (
          <ButtonProbe key={m.name} label={m.label} />
        ))}
      </Box>

      {collapsed ? (
        <>
          <IconButton
            color="inherit"
            aria-label={t('App menus')}
            aria-haspopup="true"
            aria-expanded={phase !== 'closed'}
            onClick={() => setPhase((p) => (p === 'closed' ? 'overview' : 'closed'))}
          >
            <FontAwesomeIcon icon={byPrefixAndName.fas['bars']} size="sm" />
          </IconButton>

          {phase !== 'closed' && (
            <>
              {/* Outside-click catcher — sits below both panels. */}
              <Box
                onClick={closeDrilldown}
                sx={{ position: 'fixed', inset: 0, zIndex: (theme) => theme.zIndex.appBar - 1 }}
              />
              {/* Viewport-anchored, not anchored to the icon: "the parent menu
                  goes on the left side" describes a page-level rail, not a
                  dropdown hugging wherever the icon happens to sit. TOOLBAR_HEIGHT
                  matches AppTopBar's own `<Toolbar variant="dense">` (MUI's
                  documented dense-toolbar height) rather than measuring it live. */}
              <Box
                sx={{
                  position: 'fixed',
                  top: TOOLBAR_HEIGHT,
                  left: 0,
                  width: '100vw',
                  display: 'flex',
                  zIndex: (theme) => theme.zIndex.appBar,
                }}
              >
                <Paper
                  elevation={4}
                  sx={{
                    width: phase === 'drilldown' ? '10vw' : 200,
                    minWidth: phase === 'drilldown' ? 56 : 200,
                    overflow: 'hidden',
                    flexShrink: 0,
                    transition: 'width 200ms ease, min-width 200ms ease',
                  }}
                >
                  <MenuList dense>
                    {visibleMenus.map((m) => (
                      <MenuItem
                        key={m.name}
                        selected={selected?.name === m.name}
                        onClick={() => {
                          setSelected(m)
                          setPhase('drilldown')
                        }}
                      >
                        <Typography noWrap variant="body2">
                          {t(m.label)}
                        </Typography>
                      </MenuItem>
                    ))}
                  </MenuList>
                </Paper>

                {phase === 'drilldown' && selected && (
                  <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
                    <Paper elevation={4} sx={{ minWidth: 220 }}>
                      <MenuList dense>
                        {renderMenuEntries(
                          permittedEntries(selected.entries, permissions),
                          t,
                          navigate,
                        )}
                      </MenuList>
                    </Paper>
                  </Box>
                )}
              </Box>
            </>
          )}
        </>
      ) : (
        <Box sx={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: 1 }}>
          {visibleMenus.map((m) => (
            <HeaderMenuButton key={m.name} menu={m} />
          ))}
        </Box>
      )}
    </Box>
  )
}
