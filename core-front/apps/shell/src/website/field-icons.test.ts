import { describe, expect, it } from 'vitest'
import { resolveIcon, searchIcons, SUGGESTED_ICONS } from './field-icons'

describe('field icons (Font Awesome Free)', () => {
  it('resolves an icon of each free family to its SVG data', () => {
    expect(resolveIcon('solid', 'phone')).toMatchObject({ family: 'solid', name: 'phone', width: expect.any(Number), height: 512 })
    expect(resolveIcon('regular', 'envelope')?.path).toEqual(expect.any(String))
    expect(resolveIcon('brands', 'instagram')?.name).toBe('instagram')
  })

  it('finds an icon by a former name (Font Awesome keeps them as aliases)', () => {
    expect(resolveIcon('solid', 'map-marker-alt')?.name).toBe('location-dot')
    expect(searchIcons('usd', 5).some((i) => i.name === 'dollar-sign')).toBe(true)
  })

  it('answers undefined for an unknown icon or a family with no such icon', () => {
    expect(resolveIcon('solid', 'not-an-icon')).toBeUndefined()
    expect(resolveIcon('brands', 'phone')).toBeUndefined()
  })

  it('searches every family, best matches first, within the limit', () => {
    const hits = searchIcons('phone', 10)
    expect(hits.length).toBeLessThanOrEqual(10)
    expect(hits[0].name).toBe('phone')
    expect(searchIcons('whatsapp').some((i) => i.family === 'brands' && i.name === 'whatsapp')).toBe(true)
    expect(searchIcons('zzz-nothing')).toEqual([])
    // Each icon once, though the packages export it under every alias.
    const ids = searchIcons('dollar', 60).map((i) => `${i.family}:${i.name}`)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('lists the suggestions for an empty query, and every suggestion exists', () => {
    for (const list of Object.values(SUGGESTED_ICONS)) {
      expect(searchIcons('', 100, list)).toHaveLength(list.length)
    }
  })
})
