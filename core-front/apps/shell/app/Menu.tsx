'use client'
import type { ReactNode } from 'react'
import Link from 'next/link'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import SettingsIcon from '@mui/icons-material/Settings'
import { useT, type MenuModule } from '@eerp/core-front'

// The landing menu: one square tile per installed application. A Client Component
// because each tile uses MUI's `component={Link}` (a function prop MUI can't receive
// across the RSC boundary). Purely presentational — no async, no data access,
// serializable props — so it stays trivially unit-testable; the page (page.tsx, a Server
// Component) resolves the session and feeds the registry menu here. Settings is appended
// as a built-in application (it lives in the shell, not the module registry), so it
// always has a tile.
//
// Responsive (docs/roadmaps/responsive-displays.md, Phase 1): ≥sm keeps the desktop look
// — 100×100 tiles with the label INSIDE, centered wrapping rows spanning 2/3 of the
// screen. Below sm the board becomes a centered two-per-row grid of compact 50×50 tiles;
// the in-tile caption can't fit 50px, so it hides and the label renders BELOW the tile
// instead (exactly one visible label per tile at every size — never both). All of it is
// CSS (`sx` breakpoint values), no JS media queries — the roadmap's CSS-first rule.

export interface MenuProps {
  /** Installed modules with their navigable views, already permission-filtered. */
  menu: MenuModule[]
}

/** Tile sides (px): compact on phones, the classic square from `sm` up. The whole tile
 * is the tap target, so the phone size stays above the 44px touch-target floor. */
const TILE_SIZE = { xs: 50, sm: 100 } as const

/** "crm" -> "Crm" — a readable label from a slug. */
function titleize(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * A square link tile plus its below-tile label. Inside the tile: the icon when one is
 * given, else a monogram (the label's first letter) so the compact phone tile is never
 * a blank square; the full label shows inside only from `sm` up, below only under it.
 */
function MenuTile({ href, label, icon }: { href: string; label: string; icon?: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
      <Card variant="outlined" sx={{ width: TILE_SIZE, height: TILE_SIZE }}>
        <CardActionArea
          component={Link}
          href={href}
          sx={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.5,
            p: { xs: 0.5, sm: 1 },
            textAlign: 'center',
          }}
        >
          {icon ?? (
            <Typography
              aria-hidden
              variant="h6"
              component="span"
              sx={{ display: { xs: 'inline', sm: 'none' }, lineHeight: 1 }}
            >
              {label.charAt(0).toUpperCase()}
            </Typography>
          )}
          <Typography variant="caption" sx={{ lineHeight: 1.2, display: { xs: 'none', sm: 'block' } }}>
            {label}
          </Typography>
        </CardActionArea>
      </Card>
      <Typography
        data-testid="menu-tile-label"
        variant="caption"
        align="center"
        sx={{ display: { xs: 'block', sm: 'none' }, lineHeight: 1.2, maxWidth: 90 }}
      >
        {label}
      </Typography>
    </Box>
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

      {/* The tile board. ≥sm: lines of square tiles — the row spans 2/3 of the screen,
          is centered, and the tiles are separated by 70px (wrapping into further lines).
          <sm: a centered two-column grid of the compact tiles. */}
      <Box
        sx={{
          display: { xs: 'grid', sm: 'flex' },
          gridTemplateColumns: 'repeat(2, auto)',
          justifyContent: { xs: 'center', sm: 'flex-start' },
          flexWrap: 'wrap',
          gap: { xs: 3, sm: '70px' },
          width: { xs: '100%', md: '66.6667vw' },
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
        <MenuTile href="/settings" label={t('Settings')} icon={<SettingsIcon />} />
      </Box>
    </Container>
  )
}
