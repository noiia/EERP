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
import {
  byPrefixAndName,
  FontAwesomeIcon,
  useRecordLabelStore,
  useSessionStore,
  useT,
  type Identity,
  type ModuleNav,
} from '@eerp/core-front'
import { authBffUrl } from '@/lib/auth-url'
import { setActiveCompany, type CompanyRecord } from '@/lib/company'

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

/**
 * Per-segment label overrides — for the rare path segment whose tile/page was
 * renamed without renaming the URL slug (SettingsHub.tsx's Appearance ->
 * "Global settings" tile keeps the stable /settings/appearance path on
 * purpose, so titleize()'s pure slug->title mapping never sees the rename).
 */
const SEGMENT_LABEL_OVERRIDES: Record<string, string> = {
  appearance: 'Global settings',
}

/**
 * Path segments that never correspond to a real page and so never earn a
 * breadcrumb crumb — e.g. "page-formats" in /settings/appearance/page-formats/:id:
 * the list lives embedded inline in /settings/appearance itself (no page.tsx
 * of its own), only the trailing :id route is real.
 */
const SKIPPED_SEGMENTS = new Set(['page-formats'])

/**
 * Build cumulative breadcrumb links from a pathname (excluding the menu root).
 * A module's form route often sits directly off its own root — e.g. CRM's is
 * '/crm/:id', a sibling of '/crm/list', not nested under it — so the raw path
 * alone has no segment for "List" even though that's really the record's
 * parent page. When the path is exactly that flat "/<module>/<id>" shape and
 * the module declares a `list` main page (`nav`, the same data ModuleNav's
 * own top-bar links use), splice a "List" crumb in between. Skipped when the
 * module has no list page, or the path already IS the list page itself.
 */
function crumbsFromPath(pathname: string, nav: ModuleNav[]): Crumb[] {
  const segments = pathname.split('/').filter(Boolean)
  const crumbs = segments.map((segment, i) => ({
    label: SEGMENT_LABEL_OVERRIDES[segment] ?? titleize(segment),
    href: '/' + segments.slice(0, i + 1).join('/'),
  }))

  let result = crumbs
  if (segments.length === 2) {
    const listPage = nav.find((n) => n.module === segments[0])?.pages.find((p) => p.kind === 'list')
    if (listPage && listPage.path !== pathname) {
      result = [crumbs[0], { label: 'List', href: listPage.path }, crumbs[1]]
    }
  }
  return result.filter((c) => !SKIPPED_SEGMENTS.has(c.href.split('/').filter(Boolean).at(-1) ?? ''))
}

function PathBreadcrumbs({ pathname, nav }: { pathname: string; nav: ModuleNav[] }) {
  const t = useT()
  const crumbs = crumbsFromPath(pathname, nav)
  const lastSegment = pathname.split('/').filter(Boolean).at(-1)
  // A form route's trailing crumb is otherwise the raw record id (it's just a URL
  // segment) — FormRenderer reports the record's real title-field value here
  // (record-label-store) the moment it mounts, so swap it in when it matches.
  const recordLabel = useRecordLabelStore((s) => (s.id === lastSegment ? s.label : null))
  return (
    <Breadcrumbs
      aria-label="breadcrumb"
      separator={<FontAwesomeIcon icon={byPrefixAndName.fas['chevron-right']} size="sm" />}
      sx={{ color: 'inherit', '& .MuiBreadcrumbs-separator': { color: 'inherit' } }}
    >
      {/* Root: the application menu. Plain text (current page) when already on the menu. */}
      {crumbs.length === 0 ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <FontAwesomeIcon icon={byPrefixAndName.fas['house']} size="sm" />
          <Typography variant="subtitle2" component="span">
            {t('Menu')}
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
          <FontAwesomeIcon icon={byPrefixAndName.fas['house']} size="sm" />
          {t('Menu')}
        </MuiLink>
      )}

      {/* Crumb labels are titleized slugs used as msgids: known strings ('List',
          'Settings', module names) translate; ids fall back to themselves. */}
      {crumbs.map((crumb, i) =>
        i === crumbs.length - 1 ? (
          <Typography key={crumb.href} variant="subtitle2" component="span" color="inherit">
            {/* The record's own name is never a translatable msgid, unlike every
                other crumb segment (module/page slugs) — skip t() for it. */}
            {recordLabel ?? t(crumb.label)}
          </Typography>
        ) : (
          <MuiLink key={crumb.href} component={Link} href={crumb.href} color="inherit" underline="hover">
            {t(crumb.label)}
          </MuiLink>
        ),
      )}
    </Breadcrumbs>
  )
}

/**
 * The current module's main pages (dashboard / list / settings), shown next to the
 * breadcrumb. Bolder and larger than the breadcrumb so it reads as the primary in-module
 * navigation. The active page is underlined and full-opacity. Renders nothing when the
 * current route belongs to no module with main pages (e.g. the menu or Settings).
 */
function ModuleNav({ nav, pathname }: { nav: ModuleNav[]; pathname: string }) {
  const t = useT()
  const moduleSlug = pathname.split('/').filter(Boolean)[0]
  const current = moduleSlug ? nav.find((n) => n.module === moduleSlug) : undefined
  if (!current) return null

  return (
    <Box component="nav" aria-label="module pages" sx={{ display: 'flex', alignItems: 'center', gap: 2, ml: 3 }}>
      {current.pages.map((page) => {
        const active = pathname === page.path
        return (
          <MuiLink
            key={page.path}
            component={Link}
            href={page.path}
            color="inherit"
            // underline={active ? 'always' : 'hover'}
            aria-current={active ? 'page' : undefined}
            sx={{ fontWeight: 700, opacity: active ? 1 : 0.85 }}
          >
            {t(page.label)}
          </MuiLink>
        )
      })}
    </Box>
  )
}

function UserMenu({ identity, email }: { identity: Identity; email?: string }) {
  const t = useT()
  const router = useRouter()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  // email is the closest thing to a display name this schema has (Users
  // carries no separate name field) — falls back to the raw user id only
  // when the preferences read that supplies it hasn't resolved yet.
  const displayName = email || identity.userId
  const initial = displayName.trim().charAt(0).toUpperCase() || '?'

  function close() {
    setAnchorEl(null)
  }

  async function onLogout() {
    close()
    await fetch(authBffUrl('logout'), { method: 'POST' }).catch(() => {})
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
          {t('Signed in as')} {displayName}
        </Typography>
        <Divider />
        <MenuItem component={Link} href="/settings" onClick={close}>
          <ListItemIcon>
            <FontAwesomeIcon icon={byPrefixAndName.fas['gear']} size="sm" />
          </ListItemIcon>
          <ListItemText>{t('Settings')}</ListItemText>
        </MenuItem>
        <MenuItem onClick={onLogout}>
          <ListItemIcon>
            <FontAwesomeIcon icon={byPrefixAndName.fas['right-from-bracket']} size="sm" />
          </ListItemIcon>
          <ListItemText>{t('Logout')}</ListItemText>
        </MenuItem>
      </Menu>
    </>
  )
}

/**
 * The active company's name, top-bar-right — click opens a menu listing
 * every company in the tenant; picking one switches active_company_id
 * (setActiveCompany, PUT /me/preferences) and refreshes the server tree so
 * every company-scoped setting the rest of the page reads reflects the new
 * company immediately. A trailing link still reaches the full Settings ->
 * Company list/form for editing profiles or creating a new company —
 * switching and managing are deliberately different affordances, same
 * split UserMenu already draws between "Settings" and the account actions
 * above it.
 */
function CompanySwitcher({
  activeCompany,
  companies,
}: {
  activeCompany: { id: string; name: string }
  companies: CompanyRecord[]
}) {
  const t = useT()
  const router = useRouter()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [switching, setSwitching] = useState(false)
  const open = Boolean(anchorEl)

  function close() {
    setAnchorEl(null)
  }

  async function switchTo(companyId: string) {
    close()
    if (companyId === activeCompany.id) return
    setSwitching(true)
    await setActiveCompany(companyId)
    setSwitching(false)
    router.refresh()
  }

  return (
    <>
      <Box
        component="button"
        type="button"
        onClick={(e: MouseEvent<HTMLElement>) => setAnchorEl(e.currentTarget)}
        aria-haspopup="true"
        aria-expanded={open}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          mr: 2,
          color: 'inherit',
          background: 'none',
          border: 'none',
          font: 'inherit',
          cursor: 'pointer',
          p: 0,
        }}
      >
        <FontAwesomeIcon icon={byPrefixAndName.fas['building']} size="sm" />
        {activeCompany.name}
      </Box>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ px: 2, py: 0.5, display: 'block' }}>
          {t('Switch company')}
        </Typography>
        <Divider />
        {companies.map((company) => (
          <MenuItem
            key={company.id}
            selected={company.id === activeCompany.id}
            disabled={switching}
            onClick={() => switchTo(company.id)}
          >
            <ListItemText>{company.name}</ListItemText>
          </MenuItem>
        ))}
        <Divider />
        <MenuItem component={Link} href="/settings/company" onClick={close}>
          <ListItemText>{t('Manage companies')}</ListItemText>
        </MenuItem>
      </Menu>
    </>
  )
}

export function AppTopBar({
  identity,
  nav = [],
  email,
  activeCompany = null,
  companies = [],
}: {
  identity: Identity | null
  /** Per-module main pages, resolved server-side from the registry (empty in isolation). */
  nav?: ModuleNav[]
  /** The caller's own account email — see UserMenu's displayName note. */
  email?: string
  /** The caller's current company (multi-company) — null while unresolved
   * (e.g. an identity-less render) or genuinely absent (the preferences
   * read failed upstream); the switcher just doesn't render either way. */
  activeCompany?: { id: string; name: string } | null
  /** Every company in the tenant, for the switcher's menu — empty (not an
   * error) when the list read fails; the switcher then just shows the
   * active company with nothing to switch to. */
  companies?: CompanyRecord[]
}) {
  const pathname = usePathname()
  // No bar before authentication (login page) or without a session.
  if (!identity || pathname === '/login') return null

  return (
    <AppBar position="sticky">
      <Toolbar variant="dense">
        <PathBreadcrumbs pathname={pathname} nav={nav} />
        <ModuleNav nav={nav} pathname={pathname} />
        <Box sx={{ flexGrow: 1 }} />
        {activeCompany && <CompanySwitcher activeCompany={activeCompany} companies={companies} />}
        <UserMenu identity={identity} email={email} />
      </Toolbar>
    </AppBar>
  )
}
