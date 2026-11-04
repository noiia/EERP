// The public site's palettes (ADR-035), kept apart from SiteTheme.tsx ('use client') so
// server components — blocks rendered on the server — can read the raw values too.

/** The site's base palette (light, the default). */
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

/** The dark variant: the same roles, inverted. Text and links stay AA (≥ 7:1) on paper. */
export const SITE_DARK_COLORS = {
  paper: '#191B1F',
  mist: '#23262B',
  line: '#34383F',
  ink: '#ECEDF0',
  muted: '#A3A9B3',
  link: '#8CB6EE',
} as const

export type SitePalette = { [K in keyof typeof SITE_COLORS]: string }
