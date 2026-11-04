import { describe, expect, it } from 'vitest'
import { formatMoney, formatPhone, localeCountry, presentValue, safeLocale, type FormatContext } from './field-format'

// Intl separates groups and symbols with (narrow) no-break spaces: compare on plain spaces.
const plain = (s: string | undefined) => s?.replace(/\s/g, ' ')
const ctx = (over: Partial<FormatContext> = {}): FormatContext => ({ locale: 'en', currency: 'EUR', t: (s) => s, ...over })
const show = (value: unknown, kind: Parameters<typeof presentValue>[1], over: Partial<FormatContext> = {}, format = {}, hints = {}, record = {}) =>
  presentValue(value, kind, format, ctx(over), hints, record)

describe('formatMoney', () => {
  it.each([
    [1250, 'EUR', 'fr', '1 250,00 €'],
    [1250, 'EUR', 'de', '1.250,00 €'],
    [1250, 'USD', 'en-US', '$1,250.00'],
    [1250, 'GBP', 'en-GB', '£1,250.00'],
    [1250, 'CHF', 'fr-CH', '1 250.00 CHF'], // Swiss French: a point before the cents
    [1250, 'CHF', 'de-CH', "CHF 1'250.00"],
    [1250, 'JPY', 'ja', '￥1,250'], // no minor unit
    [1250.5, 'BHD', 'en', 'BHD 1,250.500'], // three decimals
  ])('%d %s in %s → %s', (amount, currency, locale, expected) => {
    expect(plain(formatMoney(amount, currency, locale))).toBe(expected)
  })

  it('takes a fixed number of decimals when asked', () => {
    expect(plain(formatMoney(1250.456, 'EUR', 'fr', 0))).toBe('1 250 €')
    expect(plain(formatMoney(3, 'USD', 'en-US', 3))).toBe('$3.000')
  })
})

describe('monetary fields', () => {
  it('use the workspace currency by default, kept on one line', () => {
    const v = show(12, 'monetary', { locale: 'fr' })
    expect(plain(v?.text)).toBe('12,00 €')
    expect(v?.nowrap).toBe(true)
  })

  it('use a fixed currency, else a currency column of the record', () => {
    expect(plain(show(12, 'monetary', {}, { currency: 'USD' })?.text)).toBe('$12.00')
    expect(plain(show(12, 'monetary', {}, { currency_field: 'cur' }, {}, { cur: 'GBP' })?.text)).toBe('£12.00')
    // A column that doesn't hold a currency code falls back to the workspace's.
    expect(plain(show(12, 'monetary', {}, { currency_field: 'cur' }, {}, { cur: 'pounds' })?.text)).toBe('€12.00')
  })

  it('convert into the visitor currency for display only, marked ≈, the stored amount in the tooltip', () => {
    const v = show(10, 'monetary', { convert: { currency: 'USD', rate: 1.1 } })
    expect(plain(v?.text)).toBe('≈ $11.00')
    expect(plain(v?.title)).toBe('€10.00')
    // Not a workspace-currency amount: no rate applies to it, shown as is.
    expect(plain(show(10, 'monetary', { convert: { currency: 'USD', rate: 1.1 } }, { currency: 'GBP' })?.text)).toBe('£10.00')
  })

  it('show a non-numeric value untouched', () => {
    expect(show('on request', 'monetary')).toEqual({ text: 'on request' })
  })
})

describe('formatPhone', () => {
  it.each([
    ['0612345678', 'FR', '06 12 34 56 78', 'tel:+33612345678'],
    ['+33 1 23 45 67 89', 'FR', '01 23 45 67 89', 'tel:+33123456789'],
    ['2125551234', 'US', '(212) 555-1234', 'tel:+12125551234'],
    ['212-555-1234', 'US', '(212) 555-1234', 'tel:+12125551234'],
    // A number of another country than the site's is written internationally.
    ['+33612345678', 'US', '+33 6 12 34 56 78', 'tel:+33612345678'],
    ['+1 212 555 1234', 'FR', '+1 212 555 1234', 'tel:+12125551234'],
    ['+44 20 7946 0958', undefined, '+44 20 7946 0958', 'tel:+442079460958'],
  ])('%s (site country %s) → %s', (raw, country, text, href) => {
    expect(formatPhone(raw, country)).toEqual({ text, href, nowrap: true })
  })

  it('shows an unparsable number exactly as stored, linked only when it can be dialled', () => {
    expect(formatPhone('ext. 42', 'FR')).toEqual({ text: 'ext. 42', nowrap: true })
    expect(formatPhone('12', 'FR')).toEqual({ text: '12', nowrap: true })
    expect(formatPhone('+33 6 12', 'FR')).toEqual({ text: '+33 6 12', href: 'tel:+33612', nowrap: true })
    expect(formatPhone('   ', 'FR')).toBeNull()
  })

  it('never changes the value it is given (the stored number stays the caller’s)', () => {
    const stored = '06.12.34.56.78'
    const shown = formatPhone(stored, 'FR')
    expect(shown?.text).toBe('06 12 34 56 78')
    expect(stored).toBe('06.12.34.56.78')
  })

  it('uses the field’s own country, else the site’s, for numbers without a prefix', () => {
    expect(show('2125551234', 'phone', { country: 'FR' }, { country: 'US' })?.text).toBe('(212) 555-1234')
    expect(show('0612345678', 'phone', { country: 'FR' })?.text).toBe('06 12 34 56 78')
  })
})

describe('numbers, percent, rating, duration', () => {
  it('format by locale', () => {
    expect(plain(show(1234567, 'integer', { locale: 'fr' })?.text)).toBe('1 234 567')
    expect(show(1234.5678, 'decimal', { locale: 'en' })?.text).toBe('1,234.57')
    expect(show(1234.5, 'decimal', { locale: 'en' }, { decimals: 3 })?.text).toBe('1,234.500')
  })

  it('reads percent as a ratio unless the field stores percents', () => {
    expect(show(0.25, 'percent')?.text).toBe('25%')
    expect(show(25, 'percent', {}, {}, { percentBase: 'percent' })?.text).toBe('25%')
    expect(plain(show(0.125, 'percent', { locale: 'fr' })?.text)).toBe('12,5 %')
  })

  it('draws a rating as stars and says it in words', () => {
    expect(show(3, 'rating')).toEqual({ text: '★★★☆☆', spoken: '3 out of 5', nowrap: true })
    expect(show(9, 'rating', {}, {}, { max: 3 })?.text).toBe('★★★')
  })

  it('writes a duration in hours and minutes', () => {
    expect(show(90, 'duration')?.text).toBe('1 hr 30 min')
    expect(show(45, 'duration')?.text).toBe('45 min')
    expect(show(120, 'duration')?.text).toBe('2 hr')
  })
})

describe('text-like kinds', () => {
  it('links emails and websites, and leaves malformed ones as text', () => {
    expect(show('a@b.io', 'email')).toEqual({ text: 'a@b.io', href: 'mailto:a@b.io' })
    expect(show('not an email', 'email')).toEqual({ text: 'not an email' })
    expect(show('https://example.com/', 'url')).toEqual({ text: 'example.com', href: 'https://example.com/', external: true })
    expect(show('www.example.com/shop', 'url')).toEqual({ text: 'www.example.com/shop', href: 'https://www.example.com/shop', external: true })
    expect(show('javascript:alert(1)', 'url')).toEqual({ text: 'javascript:alert(1)' })
  })

  it('keeps line breaks of long text and strips the tags of an HTML field', () => {
    expect(show('One\nTwo', 'multiline')).toEqual({ text: 'One\nTwo', multiline: true })
    expect(show('<p>Hello <b>there</b></p><p>Bye &amp; thanks</p>', 'multiline')?.text).toBe('Hello there\nBye & thanks')
  })

  it('shows booleans as words, the custom ones when set', () => {
    const t = (s: string) => ({ Yes: 'Oui', No: 'Non' })[s] ?? s
    expect(show(true, 'boolean', { t })?.text).toBe('Oui')
    expect(show(false, 'boolean', { t })?.text).toBe('Non')
    expect(show(true, 'boolean', {}, { true_label: 'In stock' })?.text).toBe('In stock')
  })

  it('labels a selection value: its translation, else the value humanized', () => {
    expect(show('in_progress', 'selection')?.text).toBe('In progress')
    expect(show('draft', 'selection', { t: (s) => (s === 'draft' ? 'Brouillon' : s) })?.text).toBe('Brouillon')
  })

  it('adds a swatch to a color', () => {
    expect(show('#1d4e89', 'color')).toEqual({ text: '#1D4E89', swatch: '#1d4e89' })
  })

  it('shows nothing for empty or structured values', () => {
    for (const v of [null, undefined, '', { a: 1 }, [1]]) expect(show(v, 'text')).toBeNull()
  })
})

describe('dates', () => {
  it('reads a calendar date in UTC so it never moves a day', () => {
    expect(show('2026-03-01', 'date', { timeZone: 'Pacific/Honolulu' })?.text).toBe('Mar 1, 2026')
    expect(plain(show('2026-03-01', 'date', { locale: 'fr' }, { date_style: 'long' })?.text)).toBe('1 mars 2026')
    expect(show('2026-03-01', 'date', {}, { date_style: 'short' })?.text).toBe('03/01/2026')
  })

  it('shows a date-time with its zone, the field’s own zone when set', () => {
    expect(plain(show('2026-03-01T14:30:00Z', 'datetime', { timeZone: 'UTC' })?.text)).toBe('Mar 1, 2026, 02:30 PM UTC')
    expect(plain(show('2026-03-01T14:30:00Z', 'datetime', { locale: 'fr' }, { timezone: 'Europe/Paris' })?.text)).toBe('1 mars 2026, 15:30 UTC+1')
  })

  it('falls back to the default zone for an unknown one, and shows an unreadable date as stored', () => {
    expect(plain(show('2026-03-01T14:30:00Z', 'datetime', { timeZone: 'UTC' }, { timezone: 'Mars/Olympus' })?.text)).toBe('Mar 1, 2026, 02:30 PM UTC')
    expect(show('someday', 'date')).toEqual({ text: 'someday' })
  })
})

describe('locale helpers', () => {
  it('fall back to English on a malformed locale, and find a locale’s country', () => {
    expect(safeLocale('not a locale!')).toBe('en')
    expect(safeLocale(null)).toBe('en')
    expect(localeCountry('fr')).toBe('FR')
    expect(localeCountry('de-CH')).toBe('CH')
    expect(localeCountry('en')).toBe('US')
  })
})
