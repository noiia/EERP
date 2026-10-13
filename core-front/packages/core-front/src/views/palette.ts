// The application's brand palette: five named colors with the roles they play in an
// ERP UI. This module is intentionally dependency-free (no MUI) so the persisted
// `useUiStore` can hold the palette without dragging the theming engine into the
// store bundle. `buildAppTheme` (theme.ts) turns a palette into an MUI theme; the
// settings UI reads `BRAND_COLORS` to render an editor with human labels.

/** The five brand color slots. Each maps to a role in the MUI theme. */
export type BrandColorKey =
  | 'deepOcean'
  | 'goBlue'
  | 'softWhite'
  | 'steelGrey'
  | 'successGreen'

/** A concrete palette: a hex color per brand slot. */
export type ThemePalette = Record<BrandColorKey, string>

/** Editor metadata for a brand color — its human label and why it exists. */
export interface BrandColorInfo {
  key: BrandColorKey
  label: string
  /** Where the color is used and why, shown next to the picker in settings. */
  description: string
}

/**
 * Default palette — a calm indigo-on-navy system for long ERP sessions. The slot
 * keys are historical (they're persisted and edited by name); what matters is the
 * role each drives (see BRAND_COLORS). Every text-bearing color clears WCAG AA:
 * - goBlue (primary action) — indigo, 6.3:1 under white button text.
 * - deepOcean (headings, top bar) — near-black navy, 15.8:1 on white.
 * - softWhite (page background) — a faintly cool off-white, easier than pure white.
 * - steelGrey (secondary text, borders) — blue-grey, 5.0:1 on the page background.
 * - successGreen (success, positive figures) — a deep emerald, 5.0:1 under white text.
 * In dark mode the theme lightens the primary until it reads on the dark surfaces.
 */
export const DEFAULT_PALETTE: ThemePalette = {
  deepOcean: '#1A2238',
  goBlue: '#4F46E5',
  softWhite: '#F5F6FA',
  steelGrey: '#5E6B85',
  successGreen: '#0A7F5A',
}

/** The previous default (slate + Go cyan). A browser that still holds exactly this
 * palette never chose it, so the UI store upgrades it to DEFAULT_PALETTE. */
export const LEGACY_DEFAULT_PALETTE: ThemePalette = {
  deepOcean: '#1E293B',
  goBlue: '#00ADD8',
  softWhite: '#F8FAFC',
  steelGrey: '#64748B',
  successGreen: '#10B981',
}

/**
 * Editor metadata for the settings color manager. Each `label` names the color's ROLE in
 * the software (what it actually drives in the theme), not a marketing color name — so the
 * person editing it knows exactly what will change. Order follows visual prominence.
 */
export const BRAND_COLORS: readonly BrandColorInfo[] = [
  {
    key: 'goBlue',
    label: 'Primary action',
    description: 'Buttons, links and the keyboard focus ring — the main call-to-action accent.',
  },
  {
    key: 'deepOcean',
    label: 'Headings & navigation bar',
    description: 'Primary text, headings and the top navigation bar.',
  },
  // {
  //   key: 'softWhite',
  //   label: 'Page background',
  //   description: 'The main reading surface behind content.',
  // },
  {
    key: 'steelGrey',
    label: 'Secondary text & borders',
    description: 'Muted/secondary text, dividers and table borders.',
  },
  {
    key: 'successGreen',
    label: 'Success & positive values',
    description: 'Success states and positive financial indicators.',
  },
] as const

/** A 6-digit (or 3-digit) hex color, e.g. `#1E293B` or `#fff`. */
export function isHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}
