import { beforeEach, describe, expect, it, vi } from 'vitest'

const jar = vi.hoisted(() => ({ values: {} as Record<string, string>, set: vi.fn() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (k: string) => (k in jar.values ? { value: jar.values[k] } : undefined), set: jar.set }),
}))
const siteIdentity = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/lib/site-session', () => ({ getSiteIdentity: async () => siteIdentity.value }))
const goSiteFetch = vi.hoisted(() => vi.fn())
vi.mock('./account', () => ({ goSiteFetch }))
const localization = { default_locale: 'fr', default_currency: 'EUR', base: 'EUR', rates: { USD: 1.1 }, currencies: ['EUR', 'USD'], date_format: '' }
vi.mock('./public-api', () => ({ getLocalization: async () => localization }))
vi.mock('@eerp/core-front', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front')>()
  return { ...actual, translationRegistry: { locales: () => [{ locale: 'fr' }, { locale: 'de' }] } }
})

import { getSitePreferences } from './site-preferences'
import { saveSitePreferences } from './site-preferences-actions'
import { SITE_CURRENCY_COOKIE, SITE_LOCALE_COOKIE } from './site-prefs'

beforeEach(() => {
  jar.values = {}
  jar.set.mockReset()
  siteIdentity.value = null
  goSiteFetch.mockReset()
})

describe('getSitePreferences', () => {
  it('an anonymous visitor gets their cookies, else the site defaults', async () => {
    expect((await getSitePreferences()).prefs).toMatchObject({ locale: 'fr', currency: 'EUR' })
    jar.values = { [SITE_LOCALE_COOKIE]: 'de', [SITE_CURRENCY_COOKIE]: 'USD' }
    const p = await getSitePreferences()
    expect(p.prefs).toMatchObject({ locale: 'de', currency: 'USD' })
    expect(p.locales).toEqual(['fr', 'de'])
    expect(goSiteFetch).not.toHaveBeenCalled()
  })

  it("a signed-in visitor's account choices win over the cookies, field by field", async () => {
    siteIdentity.value = { userId: 'v' }
    jar.values = { [SITE_LOCALE_COOKIE]: 'de', [SITE_CURRENCY_COOKIE]: 'USD' }
    goSiteFetch.mockResolvedValue(new Response(JSON.stringify({ preferred_locale: 'fr', preferred_currency: null })))
    expect((await getSitePreferences()).prefs).toMatchObject({ locale: 'fr', currency: 'USD' })
  })

  it('falls back to the cookies when the account read fails', async () => {
    siteIdentity.value = { userId: 'v' }
    jar.values = { [SITE_LOCALE_COOKIE]: 'de' }
    goSiteFetch.mockResolvedValueOnce(new Response('', { status: 500 }))
    expect((await getSitePreferences()).prefs.locale).toBe('de')
    goSiteFetch.mockRejectedValueOnce(new Error('down'))
    expect((await getSitePreferences()).prefs.locale).toBe('de')
  })
})

describe('saveSitePreferences', () => {
  it('keeps valid choices in cookies only, for an anonymous visitor', async () => {
    await saveSitePreferences('pt-BR', 'USD')
    expect(jar.set).toHaveBeenCalledWith(SITE_LOCALE_COOKIE, 'pt-BR', expect.objectContaining({ path: '/', sameSite: 'lax' }))
    expect(jar.set).toHaveBeenCalledWith(SITE_CURRENCY_COOKIE, 'USD', expect.anything())
    expect(goSiteFetch).not.toHaveBeenCalled()
  })

  it('never writes a malformed value into a cookie', async () => {
    await saveSitePreferences('<script>', 'usd;')
    expect(jar.set).not.toHaveBeenCalled()
  })

  it('stores the source language as "source", and on the account when signed in (a failure is ignored)', async () => {
    siteIdentity.value = { userId: 'v' }
    goSiteFetch.mockRejectedValue(new Error('down'))
    await expect(saveSitePreferences(null, 'EUR')).resolves.toBeUndefined()
    expect(jar.set).toHaveBeenCalledWith(SITE_LOCALE_COOKIE, 'source', expect.anything())
    expect(goSiteFetch).toHaveBeenCalledWith('/website/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ preferred_locale: 'source', preferred_currency: 'EUR' }),
    })
  })
})
