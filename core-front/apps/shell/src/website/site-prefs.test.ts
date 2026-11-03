import { describe, expect, it } from 'vitest'
import { convertPrice, resolveSitePrefs } from './site-prefs'
import { sitePrefsStore } from './site-prefs-store'
import type { SiteLocalization } from './public-api'

const loc: SiteLocalization = {
  default_locale: 'fr', default_currency: 'USD', base: 'EUR',
  rates: { EUR: 1, USD: 1.1 }, currencies: ['EUR', 'USD'], date_format: 'dd/MM/yyyy',
}

describe('resolveSitePrefs', () => {
  it('keeps a valid stored choice', () => {
    expect(resolveSitePrefs({ locale: 'de', currency: 'EUR' }, loc, ['fr', 'de'])).toEqual({ locale: 'de', currency: 'EUR' })
  })
  it('honours an explicit source-language choice', () => {
    expect(resolveSitePrefs({ locale: 'source' }, loc, ['fr']).locale).toBeNull()
  })
  it('falls back to the site defaults for unknown or missing choices', () => {
    expect(resolveSitePrefs({ locale: 'xx', currency: 'JPY' }, loc, ['fr'])).toEqual({ locale: 'fr', currency: 'USD' })
  })
  it('falls back to the source language and the base when nothing is set', () => {
    const bare = { ...loc, default_locale: '', default_currency: '' }
    expect(resolveSitePrefs({}, bare, [])).toEqual({ locale: null, currency: 'EUR' })
  })
})

describe('convertPrice', () => {
  it('converts from the base at its rate', () => {
    expect(convertPrice(10, 'EUR', 'USD', loc)).toBeCloseTo(11)
  })
  it('leaves a same-currency price alone', () => {
    expect(convertPrice(10, 'EUR', 'EUR', loc)).toBe(10)
  })
  it('refuses a currency without a rate, or a price not in the base', () => {
    expect(convertPrice(10, 'EUR', 'GBP', loc)).toBeNull()
    expect(convertPrice(10, 'GBP', 'USD', loc)).toBeNull()
  })
})

describe('sitePrefsStore', () => {
  it('notifies subscribers on change', () => {
    let calls = 0
    const off = sitePrefsStore.subscribe(() => { calls++ })
    sitePrefsStore.set({ currency: 'USD' })
    off()
    sitePrefsStore.set({ currency: 'EUR' })
    expect(calls).toBe(1)
    expect(sitePrefsStore.get().currency).toBe('EUR')
  })
})
