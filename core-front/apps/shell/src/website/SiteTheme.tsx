'use client'
import { createContext, useContext, useState, type ReactNode } from 'react'
import ScopedCssBaseline from '@mui/material/ScopedCssBaseline'
import { createTheme, ThemeProvider, type SxProps, type Theme } from '@mui/material/styles'
import { SITE_COLORS, SITE_DARK_COLORS, type SitePalette } from './site-colors'
import { SITE_THEME_COOKIE, type SiteMode } from './site-prefs'

// The public website's own theme (ADR-035). The ERP theme is built from each staff
// member's palette and light/dark choice, held in their browser: the site must not
// borrow it, or every viewer would see a different site (a staff member in dark mode
// saw the whole website dark) and site headings would get the ERP's data-dense scale.
//
// Monochrome on purpose: a website's identity is the owner's content — pictures,
// section colors — so the default chrome is ink on white and never fights it. This
// module is the single place a future "site appearance" setting would feed.
//
// Visitors may switch to a dark variant (the header's toggle): the same monochrome
// idea inverted — light ink on charcoal. Their pick is a cookie (SITE_THEME_COOKIE)
// the site layout reads, so the page is server-rendered in it with no flash.

const PALETTES: Record<SiteMode, SitePalette> = { light: SITE_COLORS, dark: SITE_DARK_COLORS }

const sans = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"

// Website type scale: body at 16px (reading, not data entry) and headings large
// enough to lead a page; h1/h2 scale with the viewport so a hero fits a phone.
const heading = { fontWeight: 700, letterSpacing: '-0.02em', textWrap: 'balance' } as const
/** h1/h2 at their smallest (a phone's): the clamp() floors below. */
const PHONE_H1 = '2.25rem'
const PHONE_H2 = '1.75rem'

/** The type scale as a phone renders it, for a phone-width preview inside a wide window
 * (the page editor): h1/h2 scale with the viewport (vw), which there is the window's,
 * not the 390px sheet's. */
export const SITE_PHONE_TYPE = {
  '& .MuiTypography-h1': { fontSize: PHONE_H1 },
  '& .MuiTypography-h2': { fontSize: PHONE_H2 },
} as const

function buildSiteTheme(mode: SiteMode): Theme {
  const c = PALETTES[mode]
  return createTheme({
    palette: {
      mode,
      contrastThreshold: 4.5,
      primary: { main: c.ink, contrastText: c.paper },
      secondary: { main: c.link },
      background: { default: c.paper, paper: c.paper },
      text: { primary: c.ink, secondary: c.muted },
      divider: c.line,
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: sans,
      fontSize: 15,
      h1: { ...heading, fontSize: `clamp(${PHONE_H1}, 1.6rem + 2.6vw, 3.5rem)`, lineHeight: 1.08, fontWeight: 800 },
      h2: { ...heading, fontSize: `clamp(${PHONE_H2}, 1.4rem + 1.4vw, 2.5rem)`, lineHeight: 1.15 },
      h3: { ...heading, fontSize: '1.625rem', lineHeight: 1.2 },
      h4: { ...heading, fontSize: '1.375rem', lineHeight: 1.25 },
      h5: { fontSize: '1.125rem', lineHeight: 1.35, fontWeight: 650, letterSpacing: '-0.01em' },
      h6: { fontSize: '1rem', lineHeight: 1.4, fontWeight: 650 },
      subtitle1: { fontSize: '1.0625rem', lineHeight: 1.5, fontWeight: 600 },
      subtitle2: { fontSize: '0.9375rem', lineHeight: 1.5, fontWeight: 600 },
      body1: { fontSize: '1rem', lineHeight: 1.65 },
      body2: { fontSize: '0.9375rem', lineHeight: 1.6 },
      caption: { fontSize: '0.8125rem', lineHeight: 1.45 },
      button: { fontWeight: 600, textTransform: 'none', letterSpacing: 0 },
    },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: { root: { borderRadius: 6 }, sizeLarge: { padding: '10px 22px', fontSize: '1rem' } },
      },
      MuiLink: {
        defaultProps: { color: c.link, underline: 'hover' },
        styleOverrides: { root: { textUnderlineOffset: '0.2em' } },
      },
      MuiPaper: { defaultProps: { elevation: 0 } },
      MuiCard: { defaultProps: { elevation: 0 } },
      MuiOutlinedInput: { styleOverrides: { root: { backgroundColor: c.paper } } },
    },
  })
}

/** Both variants, built once. */
export const SITE_THEMES: Record<SiteMode, Theme> = { light: buildSiteTheme('light'), dark: buildSiteTheme('dark') }
/** The default (light) site theme. */
export const siteTheme = SITE_THEMES.light

/** The current site mode and its switch, for the header's toggle. Null outside a
 * switchable SiteTheme (the page editor's canvas shows the default look only). */
const SiteModeContext = createContext<{ mode: SiteMode; toggle: () => void } | null>(null)
export const useSiteMode = () => useContext(SiteModeContext)

/** The site theme for a subtree: the public site's layout, and the page editor's canvas
 * (so its preview is the site as visitors see it, not the ERP's look). The scoped
 * baseline resets only this subtree — the ERP chrome around the editor keeps its own.
 * `switchable` (the public site) lets the visitor toggle dark mode, starting from
 * `initialMode` (their cookie, read by the layout) and keeping each pick in that cookie. */
export function SiteTheme({ children, sx, initialMode = 'light', switchable = false }: {
  children: ReactNode
  sx?: SxProps<Theme>
  initialMode?: SiteMode
  switchable?: boolean
}) {
  const [mode, setMode] = useState<SiteMode>(initialMode)
  const toggle = () => {
    const next: SiteMode = mode === 'dark' ? 'light' : 'dark'
    setMode(next)
    // A year; not a secret, readable by the server render of the next page.
    document.cookie = `${SITE_THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
  }
  const theme = SITE_THEMES[mode]
  const tree = (
    <ThemeProvider theme={theme}>
      <ScopedCssBaseline sx={[{
        colorScheme: mode, bgcolor: 'background.default', color: 'text.primary',
        '& :focus-visible': { outline: `2px solid ${PALETTES[mode].link}`, outlineOffset: 2 },
      }, ...(Array.isArray(sx) ? sx : [sx])]}>
        {children}
      </ScopedCssBaseline>
    </ThemeProvider>
  )
  return switchable ? <SiteModeContext.Provider value={{ mode, toggle }}>{tree}</SiteModeContext.Provider> : tree
}
