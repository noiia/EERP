'use client'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import ListSubheader from '@mui/material/ListSubheader'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { useContainerWidth } from 'react-grid-layout'
import { hasPermission } from '../auth/permissions'
import { useT } from '../i18n/translate'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import type { HeaderMenu, HeaderMenuLine, HeaderMenuNode } from './header-menu-registry'
import { useSessionStore } from './session-store'

// The Odoo-style per-app top bar: one HeaderMenuButton per menu (see
// ModuleRegistry.headerMenus()), side by side, collapsing to a single icon
// with a two-level drill-down when they don't fit — see AppHeaderMenuBar.

// Stable reference — a fresh [] from the selector would make zustand see a
// new snapshot every render (same guard auth/Can.tsx's usePermission takes).
const NO_PERMISSIONS: string[] = []

/** entries.length === 1 line ⇒ that line, else null — the "a menu whose only
 * permitted content is a single line skips the dropdown, the button/item
 * navigates directly" rule HeaderMenuButton's own doc comment describes,
 * shared with AppHeaderMenuBar's collapsed overview below so a lonely entry
 * never opens a one-item submenu there either. */
function onlyLineOf(entries: HeaderMenuNode[]): HeaderMenuLine | null {
  return entries.length === 1 && entries[0].kind === 'line' ? entries[0] : null
}

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
 * no entries at all. A menu whose only permitted content is a single line
 * (every auto-generated list/catalog/dashboard menu, e.g. CRM's own single
 * Contacts view — see ModuleRegistry.headerMenus()) skips the dropdown
 * entirely: the button itself navigates, since opening a menu to show one
 * item identical to the button's own label adds a click for no information. */
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

  const onlyLine = onlyLineOf(entries)

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

  if (onlyLine) {
    return (
      <Button
        color="inherit"
        onClick={() => router.push(onlyLine.path)}
        sx={{ fontWeight: 700, textTransform: 'none', whiteSpace: 'nowrap' }}
      >
        {t(menu.label)}
      </Button>
    )
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
        // An explicit, slightly longer-than-default duration so hover-opening
        // reads as a deliberate "drop" rather than an instant pop-in — MUI's
        // Menu already animates via Grow (scales down from anchorOrigin, "top
        // left" here) on every open/close, click or hover alike.
        slotProps={{
          list: { onMouseEnter: cancelClose, onMouseLeave: scheduleClose, dense: true },
          transition: { timeout: { enter: 220, exit: 150 } },
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
 * available width, collapses to a single icon opening a two-level drill-down, styled
 * as ONE plain anchored `Menu` — the same popup PathBreadcrumbs' own narrow-mode
 * dropdown (`AppTopBar.tsx`) uses, rather than a hand-rolled fixed-position rail +
 * centered panel: clicking the icon lists every menu's title (overview); picking one
 * SWAPS the same Menu's content to that menu's own entries, with a "Back" line on top
 * (drilldown) — a real MUI Menu/Popover for free handles outside-click and Escape-to-
 * close, so neither needs its own hand-rolled listener here. A menu whose only
 * permitted content is a single line (`onlyLineOf`, shared with HeaderMenuButton's own
 * desktop posture) navigates straight from the overview instead of drilling down into
 * a one-item submenu identical to the line it would have shown anyway. Renders nothing
 * once permission-filtering leaves no menu with any entries.
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

  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const [phase, setPhase] = useState<'closed' | 'overview' | 'drilldown'>('closed')
  const [selected, setSelected] = useState<HeaderMenu | null>(null)

  function closeDrilldown() {
    setPhase('closed')
    setSelected(null)
  }
  function navigate(path: string) {
    closeDrilldown()
    router.push(path)
  }
  function pick(m: HeaderMenu) {
    const onlyLine = onlyLineOf(permittedEntries(m.entries, permissions))
    if (onlyLine) {
      navigate(onlyLine.path)
      return
    }
    setSelected(m)
    setPhase('drilldown')
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
            ref={menuButtonRef}
            color="inherit"
            aria-label={t('App menus')}
            aria-haspopup="true"
            aria-expanded={phase !== 'closed'}
            onClick={() => setPhase((p) => (p === 'closed' ? 'overview' : 'closed'))}
          >
            <FontAwesomeIcon icon={byPrefixAndName.fas['bars']} size="sm" />
          </IconButton>
          {/* One plain anchored Menu — same popup PathBreadcrumbs' own narrow-
              mode dropdown uses (AppTopBar.tsx), swapping its content between
              the overview (every menu's title) and a picked menu's own
              entries (drilldown) rather than two separate fixed-position
              panels. MUI's own Popover handles outside-click/Escape-to-close
              for free. */}
          <Menu anchorEl={menuButtonRef.current} open={phase !== 'closed'} onClose={closeDrilldown}>
            {phase === 'drilldown' && selected
              ? [
                  // Explicit way back to the overview — the ONLY navigation
                  // back short of closing and reopening the whole menu, now
                  // that there's no separate rail to click instead.
                  <MenuItem key="__back" onClick={() => setPhase('overview')}>
                    <ListItemIcon>
                      <FontAwesomeIcon icon={byPrefixAndName.fas['arrow-left']} size="sm" />
                    </ListItemIcon>
                    <ListItemText>{t('Back')}</ListItemText>
                  </MenuItem>,
                  <Divider key="__divider" />,
                  ...renderMenuEntries(permittedEntries(selected.entries, permissions), t, navigate),
                ]
              : visibleMenus.map((m) => (
                  <MenuItem key={m.name} onClick={() => pick(m)}>
                    {t(m.label)}
                  </MenuItem>
                ))}
          </Menu>
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
