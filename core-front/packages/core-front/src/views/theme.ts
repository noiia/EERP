'use client'
import Grow from '@mui/material/Grow'
import { createTheme, getContrastRatio, lighten, type Theme } from '@mui/material/styles'
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
//   contrastThreshold below) so filled buttons stay WCAG AA whatever color is picked; in
//   dark mode it is lightened until it reads on the dark surfaces (readablePrimary).
// - Deep Ocean→ secondary + the structural app-bar; light-mode headings/body text.
// - Success Green / status tokens → success / error / warning / info.
// - Neutral ramp → backgrounds, text, dividers (a superset of the brand greys).
// - tokens → radius (8), 3-step elevation, type scale, motion, focus ring.

/** The primary as used in dark mode: lightened in steps until it reaches AA (4.5:1)
 * against the dark paper, since a saturated light-mode accent (the default indigo)
 * reads as near-invisible link text on navy. A light enough color passes unchanged. */
function readablePrimary(primary: string, paper: string): string {
  let color = primary
  for (let i = 1; i <= 8 && getContrastRatio(color, paper) < 4.5; i++) color = lighten(primary, i * 0.1)
  return color
}

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
      primary: { main: isLight ? palette.goBlue : readablePrimary(palette.goBlue, palette.deepOcean) },
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
    // Every MUI transition (dialogs, menus, popovers, snackbars, collapses, tooltips)
    // takes its timing from the motion tokens, so appearing/disappearing feels the same
    // everywhere: decelerate in, accelerate out.
    transitions: {
      duration: {
        shortest: motion.duration.short,
        shorter: motion.duration.short + 30,
        short: motion.duration.standard - 20,
        standard: motion.duration.standard,
        complex: motion.duration.page,
        enteringScreen: motion.duration.enter,
        leavingScreen: motion.duration.exit,
      },
      easing: {
        easeInOut: motion.easing,
        easeOut: motion.easingEnter,
        easeIn: motion.easingExit,
        sharp: motion.easing,
      },
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
    // Read-only form fields render as MUI "disabled". In dark mode text.disabled
    // (neutral[600]) all but vanishes on the dark surfaces, so a read-only value
    // (a line's unit price, a computed total) reads in neutral[100] instead and
    // its label in the normal label color. Light mode keeps MUI's own. Disabled
    // BUTTONS still use text.disabled, so they don't look clickable.
    ...(isLight
      ? {}
      : {
          MuiInputBase: {
            styleOverrides: {
              root: {
                '&.Mui-disabled': { color: neutral[100] },
                '& .MuiInputBase-input.Mui-disabled': { WebkitTextFillColor: neutral[100] },
              },
            },
          },
          MuiFormLabel: {
            styleOverrides: { root: { '&.Mui-disabled': { color: theme.palette.text.secondary } } },
          },
          MuiFormControlLabel: {
            styleOverrides: { label: { '&.Mui-disabled': { color: neutral[100] } } },
          },
        }),
    MuiAlert: {
      styleOverrides: { root: { borderRadius: radius.sm } },
    },
    MuiAppBar: {
      // The top bar carries the structural Deep Ocean tone in both modes, hairline shadow.
      defaultProps: { color: 'secondary', elevation: 0 },
      styleOverrides: { root: { boxShadow: elevation.header } },
    },
    MuiDialog: {
      // A dialog grows out of the page instead of only fading (and shrinks back on close).
      defaultProps: { slots: { transition: Grow } },
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
