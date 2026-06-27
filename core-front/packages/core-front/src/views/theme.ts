'use client'
import { createTheme, type Theme } from '@mui/material/styles'
import { DEFAULT_PALETTE, type ThemePalette } from './palette'
import type { ThemeMode } from './ui-store'
import {
  elevation,
  focusRing,
  fontFamily,
  layout,
  motion,
  neutral,
  radius,
  status,
  typeScale,
  withAlpha,
} from './tokens'

// Turns a brand `ThemePalette` into a concrete MUI theme by composing the centralized
// design tokens (tokens.ts). This is the single place that maps brand colors + tokens
// onto MUI's semantic surface, so the rest of the app (and external modules) just consume
// `theme.*` and inherit the system automatically — change the engine, not the instances.
//
// Mapping rationale (direction "B — Surfaced"):
// - Go Blue   → primary  : the CTA / accent. Its CONTRAST TEXT is auto-derived (see
//   contrastThreshold below) so filled buttons stay WCAG AA even though #00ADD8 is light.
// - Deep Ocean→ secondary + the structural app-bar; light-mode headings/body text.
// - Success Green / status tokens → success / error / warning / info.
// - Neutral ramp → backgrounds, text, dividers (a superset of the brand greys).
// - tokens → radius (8), 3-step elevation, type scale, motion, focus ring.

export function buildAppTheme(
  palette: ThemePalette = DEFAULT_PALETTE,
  mode: ThemeMode = 'light',
): Theme {
  const isLight = mode === 'light'

  const theme = createTheme({
    // Raise the contrast threshold so MUI picks the higher-contrast text on each palette
    // color (e.g. dark text on light Go Blue) — this is the centralized AA fix.
    palette: {
      mode,
      contrastThreshold: 4.5,
      primary: { main: palette.goBlue },
      secondary: { main: palette.deepOcean },
      success: { main: palette.successGreen },
      error: { main: status.error },
      warning: { main: status.warning },
      info: { main: status.info },
      // The five brand colors are LIGHT-theme roles: in light mode each drives its own
      // role (background, text, dividers) so Settings edits take effect predictably.
      // Dark mode is DERIVED from the neutral ramp for surfaces+text — we must NOT reuse a
      // light role color (e.g. Page background / Soft White) as dark text, or editing
      // "Page background" would wrongly recolor the fonts. The one brand color carried into
      // dark mode as a surface is Deep Ocean (it IS the dark structural tone). Primary /
      // Secondary / Success are accents and apply in both modes.
      background: isLight
        ? { default: palette.softWhite, paper: neutral[0] }
        : { default: neutral[900], paper: palette.deepOcean },
      text: isLight
        ? { primary: palette.deepOcean, secondary: palette.steelGrey, disabled: neutral[400] }
        : { primary: neutral[50], secondary: neutral[400], disabled: neutral[600] },
      divider: isLight ? withAlpha(palette.steelGrey, 0.22) : withAlpha(neutral[50], 0.12),
    },
    shape: { borderRadius: radius.md },
    typography: {
      fontFamily,
      fontSize: 14,
      ...typeScale,
      button: { fontSize: '0.875rem', lineHeight: 1.5, fontWeight: 600, textTransform: 'none' },
    },
    transitions: {
      duration: { shortest: motion.duration.short, standard: motion.duration.standard },
    },
  })

  const focusColor = theme.palette.primary.main
  const surfaceBorder = `1px solid ${theme.palette.divider}`

  // Component layer: defaults + overrides that express the system. Renderers stay dumb;
  // these make stock MUI surfaces consistent (surface, focus, density) without per-screen CSS.
  theme.components = {
    MuiCssBaseline: {
      styleOverrides: {
        // Visible focus for keyboard users everywhere (WCAG 2.4.7).
        ':focus-visible': {
          outline: `2px solid ${focusColor}`,
          outlineOffset: 2,
          borderRadius: radius.sm,
        },
        // Honor reduced-motion: collapse animations/transitions/smooth-scroll.
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': {
            animationDuration: '0.01ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.01ms !important',
            scrollBehavior: 'auto !important',
          },
        },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        rounded: { borderRadius: radius.md },
        outlined: { borderColor: theme.palette.divider },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          border: surfaceBorder,
          borderRadius: radius.md,
          boxShadow: elevation.card,
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: radius.sm,
          '&.Mui-focusVisible': { boxShadow: focusRing(focusColor) },
        },
      },
    },
    MuiTextField: {
      defaultProps: { size: 'small', variant: 'outlined' },
    },
    MuiAlert: {
      styleOverrides: { root: { borderRadius: radius.sm } },
    },
    MuiAppBar: {
      // The top bar carries the structural Deep Ocean tone in both modes, hairline shadow.
      defaultProps: { color: 'secondary', elevation: 0 },
      styleOverrides: { root: { boxShadow: elevation.header } },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { borderRadius: radius.sm, fontSize: '0.75rem' },
      },
    },
  }

  return theme
}

// Re-export the layout tokens renderers reach for, so a renderer importing the theme
// module gets both in one place.
export { layout as themeLayout }
