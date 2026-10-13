import { DEFAULT_PALETTE, isHexColor, type ThemeMode, type ThemePalette } from '@eerp/core-front'

// The theme (light/dark + brand palette) lives in the browser's persisted UI store —
// which the server never sees, so it used to render every page light and the client
// switched to dark only after hydrating: a light flash on every page load. The client
// mirrors the theme into this cookie (AppThemeProvider); the root layout reads it, so
// the server renders the page in the right theme from the first byte.
//
// Not httpOnly on purpose: it holds no secret, and the client writes it.

export const THEME_COOKIE = 'eerp_theme'
const ONE_YEAR = 60 * 60 * 24 * 365

export interface InitialTheme {
  mode: ThemeMode
  palette: ThemePalette
}

export function serializeThemeCookie(mode: ThemeMode, palette: ThemePalette): string {
  return JSON.stringify({ mode, palette })
}

/** The theme a cookie value carries, or null when absent or malformed (never trust a
 * cookie's colors blindly: they end up in CSS). Missing palette slots take the default. */
export function parseThemeCookie(raw: string | undefined): InitialTheme | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const v = value as { mode?: unknown; palette?: Record<string, unknown> } | null
  if (!v || (v.mode !== 'light' && v.mode !== 'dark')) return null
  const palette: ThemePalette = { ...DEFAULT_PALETTE }
  for (const key of Object.keys(DEFAULT_PALETTE) as (keyof ThemePalette)[]) {
    const color = v.palette?.[key]
    if (color === undefined) continue
    if (typeof color !== 'string' || !isHexColor(color)) return null
    palette[key] = color
  }
  return { mode: v.mode, palette }
}

/** Client-side: writes the cookie for the next server render. */
export function writeThemeCookie(mode: ThemeMode, palette: ThemePalette): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${THEME_COOKIE}=${encodeURIComponent(serializeThemeCookie(mode, palette))}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${secure}`
}
