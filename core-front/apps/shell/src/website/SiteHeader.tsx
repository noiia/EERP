'use client'
import { useState } from 'react'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Toolbar from '@mui/material/Toolbar'
import { erpPath, T } from '@eerp/core-front'

export interface SiteHeaderProps {
  menu: { slug: string; title: string }[]
  signedIn: boolean
  staff: boolean
}

export function SiteHeader({ menu, signedIn, staff }: SiteHeaderProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const links = menu.map((p) => ({ href: p.slug ? `/${encodeURIComponent(p.slug)}` : '/', label: p.title }))
  return (
    <AppBar position="static" color="default" elevation={1}>
      <Toolbar sx={{ gap: 1 }}>
        <IconButton
          sx={{ display: { xs: 'inline-flex', md: 'none' } }}
          aria-label="Menu"
          onClick={(e) => setAnchor(e.currentTarget)}
        >
          <span aria-hidden>☰</span>
        </IconButton>
        <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
          {links.map((l) => (
            <MenuItem key={l.href} component="a" href={l.href} onClick={() => setAnchor(null)}>{l.label}</MenuItem>
          ))}
        </Menu>
        <Box sx={{ display: { xs: 'none', md: 'flex' }, gap: 1, flex: 1 }}>
          {links.map((l) => <Button key={l.href} href={l.href} color="inherit">{l.label}</Button>)}
        </Box>
        <Box sx={{ flex: { xs: 1, md: 0 } }} />
        {staff && <Button href={erpPath('/')} color="inherit"><T text="ERP" /></Button>}
        {signedIn
          ? <Button href="/account" color="inherit"><T text="My account" /></Button>
          : <Button href="/login" color="inherit"><T text="Log in" /></Button>}
      </Toolbar>
    </AppBar>
  )
}
