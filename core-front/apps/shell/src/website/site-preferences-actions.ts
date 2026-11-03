'use server'
import { cookies } from 'next/headers'
import { getSiteIdentity } from '@/lib/site-session'
import { goSiteFetch } from './account'
import { SITE_CURRENCY_COOKIE, SITE_LOCALE_COOKIE, SOURCE_LOCALE_VALUE } from './site-prefs'

const YEAR = 365 * 24 * 3600

/** Keep the visitor's footer choices: in cookies (anonymous, and the next visit
 * before sign-in) and, signed in, on the account so every device follows. */
export async function saveSitePreferences(locale: string | null, currency: string): Promise<void> {
  const value = locale ?? SOURCE_LOCALE_VALUE
  const jar = await cookies()
  const opts = { path: '/', maxAge: YEAR, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production' }
  if (/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8}){0,3}$|^source$/.test(value)) jar.set(SITE_LOCALE_COOKIE, value, opts)
  if (/^[A-Z]{3}$/.test(currency)) jar.set(SITE_CURRENCY_COOKIE, currency, opts)
  if (await getSiteIdentity()) {
    await goSiteFetch('/website/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ preferred_locale: value, preferred_currency: currency }),
    }).catch(() => null) // the cookies already hold the choice
  }
}
