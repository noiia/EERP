import type { SiteLocalization } from './public-api'

// A visitor's language and currency, picked in the site footer. The durable value
// is an account's own (website/me/preferences) or, anonymous, a cookie; the site
// layout resolves it server-side and SitePrefsSync mirrors it into the client
// store (site-prefs-store.ts). This file stays server-safe: no client-only API.

export const SITE_LOCALE_COOKIE = 'eerp_site_locale'
export const SITE_CURRENCY_COOKIE = 'eerp_site_currency'
/** The visitor's light/dark pick (the header's toggle). Absent or unknown = light. */
export const SITE_THEME_COOKIE = 'eerp_site_theme'

export type SiteMode = 'light' | 'dark'
/** The site mode a cookie value asks for; anything but `dark` is the light default. */
export const parseSiteMode = (value: string | undefined): SiteMode => (value === 'dark' ? 'dark' : 'light')
/** Stored locale value forcing the untranslated source language. */
export const SOURCE_LOCALE_VALUE = 'source'

export interface SitePrefs {
  /** Active locale tag; null = the source language. */
  locale: string | null
  /** The currency prices are shown in. */
  currency: string
}

/** The visitor's choice when it is still valid, else the site default. */
export function resolveSitePrefs(
  stored: { locale?: string | null; currency?: string | null },
  loc: SiteLocalization,
  availableLocales: string[],
): SitePrefs {
  // undefined = no valid choice here; null = the source language, chosen.
  const pickLocale = (v: string | null | undefined): string | null | undefined => {
    if (v === SOURCE_LOCALE_VALUE) return null
    return v && availableLocales.includes(v) ? v : undefined
  }
  const own = pickLocale(stored.locale)
  const fallback = pickLocale(loc.default_locale)
  const locale = own !== undefined ? own : (fallback ?? null)
  const currency = stored.currency && loc.rates[stored.currency] ? stored.currency : (loc.default_currency || loc.base)
  return { locale, currency }
}

/** `price` (in `from`, the base) in `to`, or null when no rate says how. */
export function convertPrice(price: number, from: string | undefined, to: string, loc: Pick<SiteLocalization, 'base' | 'rates'>): number | null {
  if (!from || from === to) return price
  if (from !== loc.base) return null
  const rate = loc.rates[to]
  return rate ? price * rate : null
}
