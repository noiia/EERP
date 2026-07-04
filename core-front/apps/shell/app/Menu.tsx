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

// The landing menu: one square tile per installed application, laid out as centered
// lines spanning 2/3 of the screen. A Client Component because each tile uses MUI's
// `component={Link}` (a function prop MUI can't receive across the RSC boundary).
// Purely presentational — no async, no data access, serializable props — so it stays
// trivially unit-testable; the page (page.tsx, a Server Component) resolves the session
// and feeds the registry menu here. Settings is appended as a built-in application (it
// lives in the shell, not the module registry), so it always has a tile.

export interface MenuProps {
  /** Installed modules with their navigable views, already permission-filtered. */
  menu: MenuModule[]
}

/** Fixed tile size — every application is a 100×100 square. */
const TILE_SIZE = 100

/** "crm" -> "Crm" — a readable label from a slug. */
function titleize(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** A 100×100 square link tile with a centered label (and an optional icon above it). */
function SquareTile({ href, label, icon }: { href: string; label: string; icon?: ReactNode }) {
  return (
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
          p: 1,
          textAlign: 'center',
        }}
      >
        {icon}
        <Typography variant="caption" sx={{ lineHeight: 1.2 }}>
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

      {/* Applications as lines of square tiles: the row spans 2/3 of the screen, is
          centered, and the tiles are separated by 70px (wrapping into further lines). */}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '70px',
          width: { xs: '100%', md: '66.6667vw' },
          mx: 'auto',
        }}
      >
        {menu.map((module) => (
          <SquareTile
            key={module.name}
            href={module.routes[0].path}
            label={t(titleize(module.name))}
          />
        ))}
        {/* Settings is a built-in shell application, always available. */}
        <SquareTile href="/settings" label={t('Settings')} icon={<SettingsIcon />} />
      </Box>
    </Container>
  )
}
