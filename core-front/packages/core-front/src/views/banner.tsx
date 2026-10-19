'use client'
import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Box from '@mui/material/Box'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { darken, lighten, useTheme, type Theme } from '@mui/material/styles'
import type { SxProps } from '@mui/material/styles'
import { useT } from '../i18n/translate'
import { byPrefixAndName, FontAwesomeIcon } from './icons'

// Banners: the one surface for user-facing messages — every error, warning
// and notice a view raises shows as a banner ABOVE the view it concerns
// (core-front/CLAUDE.md's "Banners" row):
//
//   - Banner: the visual piece. status 'info' (default) | 'warning' (orange) |
//     'error' (red); `color` overrides the background (default: the info
//     color — the theme's primary, lightened in light mode, darkened in dark).
//   - BannerScope + BannerSlot: a view (form, list, dashboard, the ERP page,
//     a dialog) opens a scope and places its slot above its content.
//   - ViewBanner: a Banner rendered INTO the nearest slot (a portal), from
//     wherever the message is raised — a widget deep in a form, a header
//     button, a menu — so the component that knows about the error doesn't
//     need to know where banners go. With no scope around it (the public
//     website), it renders in place.

export type BannerStatus = 'info' | 'warning' | 'error'

/** The info banner's background: the primary color lightened (light theme)
 * or darkened (dark theme) — the `color` default. */
export function infoBannerColor(theme: Theme): string {
  const primary = theme.palette.primary.main
  return theme.palette.mode === 'dark' ? darken(primary, 0.6) : lighten(primary, 0.85)
}

/** Background and text colors for a banner: `color` wins, else the status's. */
export function bannerColors(theme: Theme, status: BannerStatus, color?: string): { bg: string; fg: string } {
  const bg =
    color ??
    (status === 'warning'
      ? theme.palette.warning.main
      : status === 'error'
        ? theme.palette.error.main
        : infoBannerColor(theme))
  return { bg, fg: theme.palette.getContrastText(bg) }
}

const STATUS_ICON = {
  info: 'circle-info',
  warning: 'triangle-exclamation',
  error: 'circle-exclamation',
} as const

export interface BannerProps {
  /** info (default) | warning — orange | error — red. */
  status?: BannerStatus
  /** Any CSS color for the background; the text follows for contrast.
   * Default: the info color. */
  color?: string
  /** Bold first line. */
  title?: ReactNode
  children?: ReactNode
  /** Right-aligned controls (e.g. "Copy details"). */
  action?: ReactNode
  /** Shows a close (×) button that calls it. */
  onClose?: () => void
  sx?: SxProps<Theme>
}

export function Banner({ status = 'info', color, title, children, action, onClose, sx }: BannerProps) {
  const t = useT()
  const theme = useTheme()
  const { bg, fg } = bannerColors(theme, status, color)
  return (
    <Box
      role={status === 'info' ? 'status' : 'alert'}
      data-status={status}
      sx={[
        {
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1.5,
          px: 2,
          py: 1.25,
          borderRadius: 1,
          bgcolor: bg,
          color: fg,
          '& a': { color: 'inherit' },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      <Box sx={{ pt: 0.25, flexShrink: 0 }}>
        <FontAwesomeIcon icon={byPrefixAndName.fas[STATUS_ICON[status]]} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {title ? (
          <Typography variant="subtitle2" component="div" sx={{ fontWeight: 700, color: 'inherit' }}>
            {title}
          </Typography>
        ) : null}
        {children != null ? (
          <Typography variant="body2" component="div" sx={{ color: 'inherit' }}>
            {children}
          </Typography>
        ) : null}
      </Box>
      {action ? <Box sx={{ flexShrink: 0, alignSelf: 'center' }}>{action}</Box> : null}
      {onClose ? (
        <IconButton size="small" aria-label={t('Close')} onClick={onClose} sx={{ color: 'inherit', mt: -0.5, mr: -1 }}>
          <FontAwesomeIcon icon={byPrefixAndName.fas['xmark']} size="xs" />
        </IconButton>
      ) : null}
    </Box>
  )
}

interface BannerScopeValue {
  node: HTMLElement | null
  setNode: (node: HTMLElement | null) => void
}

const BannerScopeContext = createContext<BannerScopeValue | null>(null)

/** Opens a banner scope: every ViewBanner/ErrorAlert inside it renders into
 * the scope's BannerSlot. Scopes nest — the nearest one wins (a dialog's own
 * scope keeps its errors inside the dialog). */
export function BannerScope({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  return <BannerScopeContext.Provider value={{ node, setNode }}>{children}</BannerScopeContext.Provider>
}

/** Where the scope's banners appear — placed above the view's content.
 * Takes no room while empty. */
export function BannerSlot({ sx }: { sx?: SxProps<Theme> }) {
  const scope = useContext(BannerScopeContext)
  return (
    <Stack
      ref={scope?.setNode}
      spacing={1}
      data-banner-slot=""
      sx={[{ mb: 2, '&:empty': { display: 'none' } }, ...(Array.isArray(sx) ? sx : [sx])]}
    />
  )
}

/**
 * Renders `element` into the nearest scope's slot; in place when there is no
 * scope; nothing while the slot isn't mounted yet (its first render).
 */
export function useBannerPortal(): (element: ReactNode) => ReactNode {
  const scope = useContext(BannerScopeContext)
  return (element) => {
    if (!scope) return element
    return scope.node ? createPortal(element, scope.node) : null
  }
}

export interface ViewBannerProps extends BannerProps {
  /** Shown while true; collapses away (keeping its content while it does). */
  open?: boolean
}

/** A Banner raised from anywhere in a view, shown in the view's banner slot. */
export function ViewBanner({ open = true, ...props }: ViewBannerProps) {
  const portal = useBannerPortal()
  // The last content stays rendered while the Collapse animates shut.
  const last = useRef<BannerProps | null>(null)
  if (open) last.current = props
  const shown = open ? props : last.current
  return portal(
    <Collapse in={open} unmountOnExit>
      {shown ? <Banner {...shown} /> : null}
    </Collapse>,
  )
}
