'use client'
import { useState } from 'react'
import { usePathname } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Tooltip from '@mui/material/Tooltip'
import { alpha } from '@mui/material/styles'
import { byPrefixAndName, erpPath, FontAwesomeIcon, T, useT } from '@eerp/core-front'
import { useSiteMode } from './SiteTheme'

export interface SiteHeaderProps {
  menu: { slug: string; title: string }[]
  signedIn: boolean
  staff: boolean
}

/** Whether `href` is the page being shown (a detail page `/<slug>/<id>` counts for `/<slug>`). */
const isCurrent = (href: string, path: string | null) =>
  !!path && (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`))

// The site's header: the menu pages (the current one marked), then the visitor's own
// entries — My account or Log in, plus ERP for a signed-in staff member — and the
// light/dark toggle. Below md the pages fold into a menu button; the account entry and
// the toggle stay visible.
export function SiteHeader({ menu, signedIn, staff }: SiteHeaderProps) {
  const t = useT()
  const path = usePathname()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const links = menu.map((p) => ({ href: p.slug ? `/${encodeURIComponent(p.slug)}` : '/', label: p.title }))
  return (
    <Box component="header" sx={{
      position: 'sticky', top: 0, zIndex: (theme) => theme.zIndex.appBar,
      bgcolor: (theme) => alpha(theme.palette.background.paper, 0.92), backdropFilter: 'saturate(180%) blur(8px)', borderBottom: 1, borderColor: 'divider',
    }}>
      <Container maxWidth="lg" sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 64 }}>
        {links.length > 0 && (
          <IconButton
            sx={{ display: { xs: 'inline-flex', md: 'none' }, ml: -1 }}
            aria-label={t('Menu')}
            aria-haspopup="menu"
            aria-expanded={!!anchor}
            onClick={(e) => setAnchor(e.currentTarget)}
          >
            <FontAwesomeIcon icon={byPrefixAndName.fas.bars} />
          </IconButton>
        )}
        <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
          {links.map((l) => (
            <MenuItem key={l.href} component="a" href={l.href} selected={isCurrent(l.href, path)}
              aria-current={isCurrent(l.href, path) ? 'page' : undefined} onClick={() => setAnchor(null)}>
              {l.label}
            </MenuItem>
          ))}
        </Menu>
        <Box component="nav" aria-label={t('Main')} sx={{ display: { xs: 'none', md: 'flex' }, gap: 0.5, flex: 1, ml: -1.5 }}>
          {links.map((l) => {
            const current = isCurrent(l.href, path)
            return (
              <Button key={l.href} href={l.href} color="inherit" aria-current={current ? 'page' : undefined} sx={{
                px: 1.5, fontWeight: current ? 700 : 500, color: current ? 'text.primary' : 'text.secondary',
                // The current page: a short ink rule under its label, not a filled pill.
                position: 'relative', '&::after': current ? {
                  content: '""', position: 'absolute', left: 12, right: 12, bottom: 2, height: 2, bgcolor: 'text.primary', borderRadius: 1,
                } : undefined,
                '&:hover': { color: 'text.primary', bgcolor: 'transparent' },
              }}>
                {l.label}
              </Button>
            )
          })}
        </Box>
        <Box sx={{ flex: { xs: 1, md: 0 } }} />
        <SiteModeToggle />
        {staff && <Button href={erpPath('/')} color="inherit" sx={{ color: 'text.secondary' }}><T text="ERP" /></Button>}
        {signedIn
          ? <Button href="/account" variant="outlined" color="inherit" sx={{ borderColor: 'divider' }}><T text="My account" /></Button>
          : <Button href="/login" variant="contained"><T text="Log in" /></Button>}
      </Container>
    </Box>
  )
}

/** The visitor's light/dark switch. Its name says what a click does, not the current
 * state. Renders nothing outside a switchable SiteTheme. */
function SiteModeToggle() {
  const t = useT()
  const siteMode = useSiteMode()
  if (!siteMode) return null
  const label = siteMode.mode === 'dark' ? t('Switch to light mode') : t('Switch to dark mode')
  return (
    <Tooltip title={label}>
      <IconButton aria-label={label} onClick={siteMode.toggle} sx={{ fontSize: '1.125rem', color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>
        <FontAwesomeIcon icon={byPrefixAndName.fas[siteMode.mode === 'dark' ? 'sun' : 'moon']} fixedWidth />
      </IconButton>
    </Tooltip>
  )
}
