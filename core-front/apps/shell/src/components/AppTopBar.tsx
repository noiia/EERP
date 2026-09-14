'use client'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
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
import useMediaQuery from '@mui/material/useMediaQuery'
import {
  AppHeaderMenuBar,
  byPrefixAndName,
  FontAwesomeIcon,
  layout,
  moduleRegistry,
  nextBreadcrumbTrail,
  useBreadcrumbStore,
  useRecordLabelStore,
  useSessionStore,
  useT,
  type Crumb,
  type Identity,
  type ModuleHeaderMenus,
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

/**
 * Per-segment label overrides — for the rare path segment whose tile/page was
 * renamed without renaming the URL slug (SettingsHub.tsx's Appearance ->
 * "Global settings" tile keeps the stable /settings/appearance path on
 * purpose, so titleize()'s pure slug->title mapping never sees the rename).
 * `propertymanagement` is a different case of the same problem: the module
 * FOLDER/package name has no word separator at all (the scaffolding tool's
 * name regex forbids underscores there — module.go's own doc comment), so
 * titleize() can't split it into "Property Management" the way it splits
 * hyphenated slugs like "product-variant" — this restores the word break
 * titleize() would have produced on its own, matching module.json's
 * display_name (the landing-menu tile's own label).
 */
const SEGMENT_LABEL_OVERRIDES: Record<string, string> = {
  appearance: 'Global settings',
  propertymanagement: 'Property Management',
}

/**
 * The CURRENT pathname's own breadcrumb crumb — ONE crumb, never an ancestor
 * chain inferred from the URL's path segments. The breadcrumb TRAIL
 * (breadcrumb-store.ts) is what accumulates multiple crumbs, one per page
 * the user actually navigated through; this only decides what the page at
 * `pathname` itself should be called. That split is what keeps a page
 * reached directly — e.g. clicking a row inside an unrelated record's
 * embedded relation grid, never visiting that record's own list — from
 * getting a synthetic "List" (or any other) ancestor spliced in for a page
 * the user never actually passed through. `null` on the menu root itself
 * (nothing to show — PathBreadcrumbs renders the root "Menu" crumb instead).
 */
function crumbForPath(pathname: string, t: (msgid: string) => string): Crumb | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return null

  // "Settings > Apps > <module>" is three URL segments of internal path
  // structure that read as noise once the user arrived here from an
  // unrelated app or record — collapse it to the ONE crumb that actually
  // names the page: the module's own Configuration screen. The module's
  // display name is DATA (module.json's display_name, e.g. "CRM"), so — like
  // a record's own name — it skips t(); only "Configuration" is a real
  // translatable msgid.
  if (segments.length === 3 && segments[0] === 'settings' && segments[1] === 'apps') {
    const moduleName = segments[2]
    const displayName = moduleRegistry.displayNameFor(moduleName) ?? titleize(moduleName)
    return { label: `${t('Configuration')} (${displayName})`, href: pathname }
  }

  const lastSegment = segments[segments.length - 1]

  // Already on a list page ("/<module>/list", "/sale/quote/list", ...): the
  // view's own segment never got its own real page anyway (CRM's form is
  // '/crm/:id', a sibling of '/crm/list', not nested under it), so fold it
  // into ONE crumb ("Quote - List") instead of a dead-link "Quote" ancestor.
  // Each half is translated separately before joining, so a locale's "List"
  // translation still applies even though the two now render as one crumb.
  if (segments.length >= 2 && lastSegment === 'list') {
    const entitySegment = segments[segments.length - 2]
    const entityLabel = SEGMENT_LABEL_OVERRIDES[entitySegment] ?? titleize(entitySegment)
    return { label: `${t(entityLabel)} - ${t('List')}`, href: pathname }
  }

  return { label: SEGMENT_LABEL_OVERRIDES[lastSegment] ?? titleize(lastSegment), href: pathname }
}

function PathBreadcrumbs({ pathname }: { pathname: string }) {
  const t = useT()

  const lastSegment = pathname.split('/').filter(Boolean).at(-1)
  // A form route's trailing crumb is otherwise the raw record id (it's just a URL
  // segment) — FormRenderer reports the record's real title-field value here
  // (record-label-store) the moment it mounts, preferring a `display_name`
  // field when the entity has one (synthesizeFormLayout). Baked into the
  // crumb itself below (not just read at render time for the current page)
  // so the friendly name STICKS once this page stops being the current one
  // — otherwise it would fall back to the raw titleized id the moment the
  // user navigates one step further.
  const recordLabel = useRecordLabelStore((s) => (s.id === lastSegment ? s.label : null))

  // This page's own crumb (never an ancestor chain — see crumbForPath), with
  // its label swapped for the resolved record name once known.
  const currentCrumb = useMemo(() => {
    const base = crumbForPath(pathname, t)
    return base && recordLabel ? { ...base, label: recordLabel } : base
  }, [pathname, recordLabel])
  // Merged with whatever was already in the cross-navigation trail (see
  // breadcrumb-store.ts): a genuinely new page appends after it, and
  // returning to an already-visited page truncates the forward history —
  // computed here (not just inside the effect below) so the FIRST render
  // after a navigation already shows the merged trail with no one-frame
  // flash of the stale one.
  const storedTrail = useBreadcrumbStore((s) => s.trail)
  const trail = useMemo(
    () => nextBreadcrumbTrail(storedTrail, currentCrumb),
    [storedTrail, currentCrumb],
  )
  useEffect(() => {
    // Also re-fires once recordLabel resolves (asynchronously, shortly after
    // a form route mounts) so the already-visited entry gets its baked-in
    // friendly name too, not just crumbs visited from here on.
    useBreadcrumbStore.getState().visit(currentCrumb)
  }, [pathname, recordLabel])
  const narrow = useMediaQuery(`(max-width:${layout.breadcrumbCollapseWidth}px)`)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)

  // Below breadcrumbCollapseWidth, a full trail rarely fits next to the nav/avatar —
  // collapse it to a single "…" summary button plus the current page only. Clicking
  // it opens every crumb in a Menu (which stacks its MenuItems VERTICALLY by nature)
  // instead of falling through to MUI Breadcrumbs' own built-in collapse below, which
  // would re-expand everything back INLINE — still too wide for this screen.
  if (narrow && trail.length > 0) {
    const open = Boolean(anchorEl)
    function close() {
      setAnchorEl(null)
    }
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        <IconButton
          size="small"
          color="inherit"
          aria-label="Breadcrumb trail"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={(e: MouseEvent<HTMLElement>) => setAnchorEl(e.currentTarget)}
        >
          <FontAwesomeIcon icon={byPrefixAndName.fas['ellipsis-vertical']} size="sm" />
        </IconButton>
        <Typography
          variant="subtitle2"
          component="span"
          color="inherit"
          sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {recordLabel ?? t(trail[trail.length - 1].label)}
        </Typography>
        <Menu anchorEl={anchorEl} open={open} onClose={close}>
          <MenuItem component={Link} href="/" onClick={close}>
            <ListItemIcon>
              <FontAwesomeIcon icon={byPrefixAndName.fas['house']} size="sm" />
            </ListItemIcon>
            <ListItemText>{t('Menu')}</ListItemText>
          </MenuItem>
          {trail.map((crumb, i) =>
            i === trail.length - 1 ? (
              <MenuItem key={crumb.href} disabled>
                <ListItemText>{recordLabel ?? t(crumb.label)}</ListItemText>
              </MenuItem>
            ) : (
              <MenuItem key={crumb.href} component={Link} href={crumb.href} onClick={close}>
                <ListItemText>{t(crumb.label)}</ListItemText>
              </MenuItem>
            ),
          )}
        </Menu>
      </Box>
    )
  }

  return (
    <Breadcrumbs
      aria-label="breadcrumb"
      separator={<FontAwesomeIcon icon={byPrefixAndName.fas['chevron-right']} size="sm" />}
      // When there are more crumbs than fit comfortably, collapse the OLDER
      // (earlier/ancestor) ones under a single "…" rather than wrapping to a
      // second line — itemsBeforeCollapse=0 means even the root "Menu" crumb
      // can fold into the ellipsis, leaving exactly "… > parent > current".
      // Count-based (MUI's own built-in mechanism), not a true measured-width
      // collapse — good enough for how deep this app's breadcrumbs realistically get.
      maxItems={4}
      itemsBeforeCollapse={0}
      itemsAfterCollapse={2}
      sx={{ color: 'inherit', '& .MuiBreadcrumbs-separator': { color: 'inherit' } }}
    >
      {/* Root: the application menu. Plain text (current page) when already on the menu. */}
      {trail.length === 0 ? (
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
      {trail.map((crumb, i) =>
        i === trail.length - 1 ? (
          <Typography key={crumb.href} variant="subtitle2" component="span" color="inherit">
            {/* The record's own name is never a translatable msgid, unlike every
                other crumb segment (module/page slugs) — skip t() for it. */}
            {recordLabel ?? t(crumb.label)}
          </Typography>
        ) : (
          <MuiLink
            key={crumb.href}
            component={Link}
            href={crumb.href}
            color="inherit"
            underline="hover"
          >
            {t(crumb.label)}
          </MuiLink>
        ),
      )}
    </Breadcrumbs>
  )
}

/**
 * The current module's own top-bar header menus (Odoo-style "Orders / To
 * Invoice / Products / Configuration"), shown next to the breadcrumb — see
 * ModuleRegistry.headerMenus(). This Box is ALWAYS the Toolbar's one
 * flex-growing item — even with no current module, so it keeps doing the
 * spacer's job of pushing CompanySwitcher/UserMenu to the right (there is no
 * separate spacer Box any more; a second flexGrow item here would each only
 * get HALF the Toolbar's free width, which is exactly what made
 * AppHeaderMenuBar measure its available space as too narrow and collapse to
 * the phone-style icon even with plenty of room on screen).
 */
function CurrentModuleHeaderMenus({
  menus,
  pathname,
}: {
  menus: ModuleHeaderMenus[]
  pathname: string
}) {
  const moduleSlug = pathname.split('/').filter(Boolean)[0]
  const current = moduleSlug ? menus.find((m) => m.module === moduleSlug) : undefined

  return (
    <Box
      component="nav"
      aria-label="module pages"
      sx={{ ml: current ? 3 : 0, minWidth: 0, flexGrow: 1, display: 'flex' }}
    >
      {current && <AppHeaderMenuBar menus={current.menus} />}
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
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ px: 2, py: 0.5, display: 'block' }}
        >
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
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ px: 2, py: 0.5, display: 'block' }}
        >
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
  headerMenus = [],
  email,
  activeCompany = null,
  companies = [],
}: {
  identity: Identity | null
  /** Per-module top-bar header menus, resolved server-side from the registry
   * (empty in isolation) — see ModuleRegistry.headerMenus(). */
  headerMenus?: ModuleHeaderMenus[]
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
    <>
      {/* position="fixed" (MUI's own default — spelled out here since sticky used to
          override it) pins the bar to the viewport top on every view, regardless of
          which element actually scrolls; it's no longer just "stuck" within its own
          scroll container. */}
      <AppBar position="fixed">
        <Toolbar variant="dense">
          <PathBreadcrumbs pathname={pathname} />
          <CurrentModuleHeaderMenus menus={headerMenus} pathname={pathname} />
          {activeCompany && <CompanySwitcher activeCompany={activeCompany} companies={companies} />}
          <UserMenu identity={identity} email={email} />
        </Toolbar>
      </AppBar>
      {/* Reserves the AppBar's height in normal document flow — position: fixed takes
          the real Toolbar above out of flow entirely, so every view's content would
          otherwise start underneath the bar instead of below it. A real (hidden)
          Toolbar of the SAME variant rather than a hardcoded height, so it can never
          drift out of sync with the actual bar. Rendered right alongside it, so it
          only ever exists when the bar itself does (never on /login). */}
      <Toolbar variant="dense" sx={{ visibility: 'hidden' }} />
    </>
  )
}
