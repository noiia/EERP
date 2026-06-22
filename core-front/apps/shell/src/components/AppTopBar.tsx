'use client'
import { useState, type MouseEvent } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import AppBar from '@mui/material/AppBar'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Breadcrumbs from '@mui/material/Breadcrumbs'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import MuiLink from '@mui/material/Link'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import HomeIcon from '@mui/icons-material/Home'
import LogoutIcon from '@mui/icons-material/Logout'
import NavigateNextIcon from '@mui/icons-material/NavigateNext'
import SettingsIcon from '@mui/icons-material/Settings'
import { useSessionStore, type Identity } from '@eerp/core-front'

// The persistent application top bar (shell chrome). Shown on every authenticated route:
// left = the module breadcrumb (fil d'Ariane) derived from the path, rooted at the menu;
// right = the signed-in user's avatar with a dropdown (Settings, Logout). A Client
// Component because it reads the current path and drives the logout flow. Hidden on the
// login page and whenever there is no session.

/** "crm" -> "Crm", "/crm/contacts" -> "Contacts". */
function titleize(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

interface Crumb {
  label: string
  href: string
}

/** Build cumulative breadcrumb links from a pathname (excluding the menu root). */
function crumbsFromPath(pathname: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean)
  return segments.map((segment, i) => ({
    label: titleize(segment),
    href: '/' + segments.slice(0, i + 1).join('/'),
  }))
}

function PathBreadcrumbs({ pathname }: { pathname: string }) {
  const crumbs = crumbsFromPath(pathname)
  return (
    <Breadcrumbs
      aria-label="breadcrumb"
      separator={<NavigateNextIcon fontSize="small" />}
      sx={{ color: 'inherit', flexGrow: 1, '& .MuiBreadcrumbs-separator': { color: 'inherit' } }}
    >
      {/* Root: the application menu. Plain text (current page) when already on the menu. */}
      {crumbs.length === 0 ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <HomeIcon fontSize="small" />
          <Typography variant="subtitle2" component="span">
            Menu
          </Typography>
        </Box>
      ) : (
        <MuiLink
          component={Link}
          href="/"
          color="inherit"
          underline="hover"
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
        >
          <HomeIcon fontSize="small" />
          Menu
        </MuiLink>
      )}

      {crumbs.map((crumb, i) =>
        i === crumbs.length - 1 ? (
          <Typography key={crumb.href} variant="subtitle2" component="span" color="inherit">
            {crumb.label}
          </Typography>
        ) : (
          <MuiLink key={crumb.href} component={Link} href={crumb.href} color="inherit" underline="hover">
            {crumb.label}
          </MuiLink>
        ),
      )}
    </Breadcrumbs>
  )
}

function UserMenu({ identity }: { identity: Identity }) {
  const router = useRouter()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  const initial = identity.userId.trim().charAt(0).toUpperCase() || '?'

  function close() {
    setAnchorEl(null)
  }

  async function onLogout() {
    close()
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    useSessionStore.getState().clear()
    router.push('/login')
    router.refresh()
  }

  return (
    <>
      <IconButton
        onClick={(e: MouseEvent<HTMLElement>) => setAnchorEl(e.currentTarget)}
        size="small"
        aria-label="Account menu"
        aria-haspopup="true"
        aria-expanded={open}
        color="inherit"
      >
        <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: '0.875rem' }}>
          {initial}
        </Avatar>
      </IconButton>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ px: 2, py: 0.5, display: 'block' }}>
          Signed in as {identity.userId}
        </Typography>
        <Divider />
        <MenuItem component={Link} href="/settings" onClick={close}>
          <ListItemIcon>
            <SettingsIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Settings</ListItemText>
        </MenuItem>
        <MenuItem onClick={onLogout}>
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Logout</ListItemText>
        </MenuItem>
      </Menu>
    </>
  )
}

export function AppTopBar({ identity }: { identity: Identity | null }) {
  const pathname = usePathname()
  // No bar before authentication (login page) or without a session.
  if (!identity || pathname === '/login') return null

  return (
    <AppBar position="sticky">
      <Toolbar variant="dense">
        <PathBreadcrumbs pathname={pathname} />
        <UserMenu identity={identity} />
      </Toolbar>
    </AppBar>
  )
}
