import 'server-only'
import { cookies } from 'next/headers'
import { translationRegistry } from '@eerp/core-front'
import '@/generated/generated-translations'
import { getSiteIdentity } from '@/lib/site-session'
import { goSiteFetch } from './account'
import { getLocalization, type SiteLocalization } from './public-api'
import { resolveSitePrefs, SITE_CURRENCY_COOKIE, SITE_LOCALE_COOKIE, type SitePrefs } from './site-prefs'

/** The visitor's stored choices: the account's own when signed in, each falling
 * back to the browser's cookie (a choice made before signing up). */
async function storedChoices(): Promise<{ locale?: string | null; currency?: string | null }> {
  const jar = await cookies()
  const cookie = { locale: jar.get(SITE_LOCALE_COOKIE)?.value, currency: jar.get(SITE_CURRENCY_COOKIE)?.value }
  if (!(await getSiteIdentity())) return cookie
  const res = await goSiteFetch('/website/me').catch(() => null)
  if (!res?.ok) return cookie
  const me = (await res.json()) as { preferred_locale?: string | null; preferred_currency?: string | null }
  return { locale: me.preferred_locale ?? cookie.locale, currency: me.preferred_currency ?? cookie.currency }
}

/** What the site renders with: the visitor's language and currency, and the rates. */
export async function getSitePreferences(): Promise<{ prefs: SitePrefs; localization: SiteLocalization; locales: string[] }> {
  const [localization, stored] = await Promise.all([getLocalization(), storedChoices()])
  const locales = translationRegistry.locales().map((l) => l.locale)
  return { prefs: resolveSitePrefs(stored, localization, locales), localization, locales }
}
