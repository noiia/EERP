import { beforeEach, describe, expect, it, vi } from 'vitest'

const identity = vi.hoisted(() => ({ value: { userId: 'u' } as unknown }))
vi.mock('@/lib/session', () => ({ getIdentity: async () => identity.value }))
const listMock = vi.hoisted(() => vi.fn())
vi.mock('./public-api', () => ({ serverPublicSource: { list: listMock, get: async () => null } }))
vi.mock('./site-preferences', () => ({
  getSitePreferences: async () => ({
    prefs: { locale: 'en', currency: 'EUR' },
    localization: { default_locale: 'fr', default_currency: 'EUR', base: 'EUR', rates: {}, currencies: ['EUR'], date_format: '' },
    locales: ['en'],
  }),
}))

import { describeFields, previewField, searchFieldIcons } from './field-display-actions'
import type { FieldKind } from './field-display'

const plain = (s: string | undefined) => s?.replace(/\s/g, ' ')

beforeEach(() => {
  identity.value = { userId: 'u' }
  listMock.mockReset().mockResolvedValue({ records: [] })
})

describe('describeFields', () => {
  it('is empty for an anonymous caller or no table', async () => {
    identity.value = null
    expect(await describeFields('demo', ['a'])).toEqual({})
    identity.value = { userId: 'u' }
    expect(await describeFields('', ['a'])).toEqual({})
    expect(listMock).not.toHaveBeenCalled()
  })

  it('reads kinds from the first published row, and survives a failed read', async () => {
    listMock.mockResolvedValueOnce({ records: [{ id: '1', unit_price: 12, email: 'a@b.io' }] })
    expect(await describeFields('demo', ['unit_price', 'email'])).toEqual({ unit_price: { kind: 'monetary' }, email: { kind: 'email' } })
    listMock.mockRejectedValueOnce(new Error('down'))
    expect(await describeFields('demo', ['phone'])).toEqual({ phone: { kind: 'phone' } })
  })
})

describe('searchFieldIcons', () => {
  it('is empty for an anonymous caller', async () => {
    identity.value = null
    expect(await searchFieldIcons('phone')).toEqual([])
  })

  it('suggests icons for a kind and finds them by name', async () => {
    const suggested = await searchFieldIcons('', 'phone')
    expect(suggested.length).toBeGreaterThan(0)
    const found = await searchFieldIcons('envelope')
    expect(found.some((i) => i.name.includes('envelope'))).toBe(true)
  })
})

describe('previewField', () => {
  it('is null for an anonymous caller, no table or no field', async () => {
    expect(await previewField('', 'a', {})).toBeNull()
    expect(await previewField('demo', '', {})).toBeNull()
    identity.value = null
    expect(await previewField('demo', 'a', {})).toBeNull()
  })

  it('shows a real published value when one exists', async () => {
    listMock.mockResolvedValue({ records: [{ id: '1', unit_price: null }, { id: '2', unit_price: 1250 }] })
    const p = await previewField('demo', 'unit_price', {})
    expect(p?.sample).toBe(false)
    expect(plain(p?.value?.text)).toBe('€1,250.00')
  })

  it('falls back to a sample when no row holds a value (and when the read fails)', async () => {
    listMock.mockRejectedValue(new Error('down'))
    const p = await previewField('demo', 'notes', {})
    expect(p).toMatchObject({ sample: true, value: { text: 'Sample text' } })
  })

  it.each<[FieldKind, RegExp]>([
    ['phone', /06 12 34 56 78|\+1/],
    ['monetary', /1,250/],
    ['integer', /1,250/],
    ['decimal', /1,234\.5/],
    ['percent', /25/],
    ['rating', /★/],
    ['duration', /1/],
    ['boolean', /./],
    ['date', /2026|Mar/],
    ['datetime', /2026|Mar/],
    ['selection', /progress/i],
    ['email', /contact@example\.com/],
    ['url', /example\.com/],
    ['multiline', /First line/],
    ['color', /#1D4E89/i],
    ['relation', /Sample text/],
  ])('a %s sample', async (kind, expected) => {
    const p = await previewField('demo', 'x', { format: { as: kind } })
    expect(p?.sample).toBe(true)
    expect(plain(p?.value?.text ?? p?.value?.spoken ?? '')).toMatch(expected)
  })

  it('writes a sample phone the national way for the business country', async () => {
    const p = await previewField('demo', 'phone', { format: { country: 'FR' } })
    expect(plain(p?.value?.text)).toBe('06 12 34 56 78')
  })
})
