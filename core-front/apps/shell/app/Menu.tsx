'use client'
import type { ReactNode } from 'react'
import Link from 'next/link'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import { byPrefixAndName, FontAwesomeIcon, layout, useT, type MenuModule } from '@eerp/core-front'

// The landing menu: one square tile per installed application. A Client Component
// because each tile uses MUI's `component={Link}` (a function prop MUI can't receive
// across the RSC boundary). Purely presentational — no async, no data access,
// serializable props — so it stays trivially unit-testable; the page (page.tsx, a Server
// Component) resolves the session and feeds the registry menu here. Settings is appended
// as a built-in application (it lives in the shell, not the module registry), so it
// always has a tile.
//
// Responsive (docs/roadmaps/responsive-displays.md): at/above `layout.mobileBreakpoint`
// (720px) keeps the desktop look — 100×100 tiles, label inside, centered wrapping rows
// spanning 2/3 of the screen. Below it the board becomes a single centered column of
// BIGGER 300×300 tiles (still label inside — spacious enough not to need a below-tile
// duplicate) — fewer, larger touch targets read better on a phone than a shrunk grid.
// All of it is CSS (`sx`'s raw `@media` key), no JS media queries.

export interface MenuProps {
  /** Installed modules with their navigable views, already permission-filtered. */
  menu: MenuModule[]
}

const mobileMediaQuery = `@media (min-width:${layout.mobileBreakpoint}px)` as const

/** Tile side (px): bigger below `layout.mobileBreakpoint`, the classic square at/above
 * it. The whole tile is the tap target either way. */
const TILE_SIZE_COMPACT = 300
const TILE_SIZE_DEFAULT = 100

/** "crm" -> "Crm" — a readable label from a slug. */
function titleize(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * A square link tile: the icon when one is given, else a monogram (the label's first
 * letter) so a tile is never blank, plus the label — both always inside the tile at
 * every size, since even the compact tier (300px) is spacious enough.
 */
function MenuTile({ href, label, icon }: { href: string; label: string; icon?: ReactNode }) {
  return (
    <Card
      variant="outlined"
      sx={{
        width: TILE_SIZE_COMPACT,
        height: TILE_SIZE_COMPACT,
        [mobileMediaQuery]: { width: TILE_SIZE_DEFAULT, height: TILE_SIZE_DEFAULT },
      }}
    >
      <CardActionArea
        component={Link}
        href={href}
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          p: 2,
          [mobileMediaQuery]: { gap: 0.5, p: 1 },
          textAlign: 'center',
        }}
      >
        {icon ?? (
          <Typography
            aria-hidden
            variant="h3"
            component="span"
            sx={{ lineHeight: 1, [mobileMediaQuery]: { fontSize: '1.25rem' } }}
          >
            {label.charAt(0).toUpperCase()}
          </Typography>
        )}
        <Typography variant="body1" sx={{ lineHeight: 1.2, [mobileMediaQuery]: { fontSize: '0.75rem' } }}>
          {label}
        </Typography>
      </CardActionArea>
    </Card>
  )
}

export default function Menu({ menu }: MenuProps) {
  // Tile labels are titleized module names — msgids like any other string, so a
  // module can localize its own tile by translating its titleized name in its .po.
  const t = useT()
  return (
    <Container maxWidth={false} sx={{ py: 6 }}>
      {menu.length === 0 ? (
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          {t('No applications are available for your account.')}
        </Typography>
      ) : null}

      {/* The tile board. At/above layout.mobileBreakpoint: lines of square tiles — the
          row spans 2/3 of the screen, is centered, tiles separated by 70px (wrapping
          into further lines). Below it: a single centered column of the bigger tiles —
          two 300px tiles never fit side by side on a phone. */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 3,
          width: '100%',
          [mobileMediaQuery]: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
            gap: '70px',
            width: '66.6667vw',
          },
          mx: 'auto',
        }}
      >
        {menu.map((module) => (
          <MenuTile
            key={module.name}
            href={module.routes[0].path}
            label={t(titleize(module.name))}
          />
        ))}
        {/* Settings is a built-in shell application, always available. */}
        <MenuTile
          href="/settings"
          label={t('Settings')}
          icon={<FontAwesomeIcon icon={byPrefixAndName.fas['gear']} />}
        />
      </Box>
    </Container>
  )
}
