'use client'
import type { ReactNode } from 'react'
import ScopedCssBaseline from '@mui/material/ScopedCssBaseline'
import { createTheme, ThemeProvider, type SxProps, type Theme } from '@mui/material/styles'

// The public website's own theme (ADR-035). The ERP theme is built from each staff
// member's palette and light/dark choice, held in their browser: the site must not
// borrow it, or every viewer would see a different site (a staff member in dark mode
// saw the whole website dark) and site headings would get the ERP's data-dense scale.
//
// Monochrome on purpose: a website's identity is the owner's content — pictures,
// section colors — so the default chrome is ink on white and never fights it. This
// module is the single place a future "site appearance" setting would feed.

/** The site's base palette. */
export const SITE_COLORS = {
  paper: '#FFFFFF',
  /** Bands, table heads, quiet surfaces. */
  mist: '#F3F4F6',
  line: '#E2E4E9',
  ink: '#1C1F24',
  muted: '#5A606B',
  /** Links and focus: a deep blue that reads as "clickable" on white (AA 8:1). */
  link: '#1D4E89',
} as const

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

export const siteTheme: Theme = createTheme({
  palette: {
    mode: 'light',
    contrastThreshold: 4.5,
    primary: { main: SITE_COLORS.ink, contrastText: '#FFFFFF' },
    secondary: { main: SITE_COLORS.link },
    background: { default: SITE_COLORS.paper, paper: SITE_COLORS.paper },
    text: { primary: SITE_COLORS.ink, secondary: SITE_COLORS.muted },
    divider: SITE_COLORS.line,
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
      defaultProps: { color: SITE_COLORS.link, underline: 'hover' },
      styleOverrides: { root: { textUnderlineOffset: '0.2em' } },
    },
    MuiPaper: { defaultProps: { elevation: 0 } },
    MuiCard: { defaultProps: { elevation: 0 } },
    MuiOutlinedInput: { styleOverrides: { root: { backgroundColor: SITE_COLORS.paper } } },
  },
})

/** The site theme for a subtree: the public site's layout, and the page editor's canvas
 * (so its preview is the site as visitors see it, not the ERP's look). The scoped
 * baseline resets only this subtree — the ERP chrome around the editor keeps its own. */
export function SiteTheme({ children, sx }: { children: ReactNode; sx?: SxProps<Theme> }) {
  return (
    <ThemeProvider theme={siteTheme}>
      <ScopedCssBaseline sx={[{
        colorScheme: 'light', bgcolor: 'background.default', color: 'text.primary',
        '& :focus-visible': { outline: `2px solid ${SITE_COLORS.link}`, outlineOffset: 2 },
      }, ...(Array.isArray(sx) ? sx : [sx])]}>
        {children}
      </ScopedCssBaseline>
    </ThemeProvider>
  )
}
