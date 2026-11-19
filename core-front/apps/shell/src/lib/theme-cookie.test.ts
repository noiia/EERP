import { describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE } from '@eerp/core-front'
import { parseThemeCookie, serializeThemeCookie } from './theme-cookie'

describe('theme cookie', () => {
  it('round-trips the mode and palette', () => {
    const palette = { ...DEFAULT_PALETTE, goBlue: '#123456' }
    expect(parseThemeCookie(serializeThemeCookie('dark', palette))).toEqual({ mode: 'dark', palette })
  })

  it.each([
    ['absent', undefined],
    ['not JSON', 'nope'],
    ['unknown mode', JSON.stringify({ mode: 'sepia', palette: DEFAULT_PALETTE })],
    ['a palette color that is not a hex color', JSON.stringify({ mode: 'dark', palette: { ...DEFAULT_PALETTE, goBlue: 'red;}' } })],
  ])('ignores a cookie that is %s', (_label, raw) => {
    expect(parseThemeCookie(raw)).toBeNull()
  })

  it('fills palette slots an older cookie lacks with the defaults', () => {
    expect(parseThemeCookie(JSON.stringify({ mode: 'dark', palette: { goBlue: '#123456' } }))).toEqual({
      mode: 'dark',
      palette: { ...DEFAULT_PALETTE, goBlue: '#123456' },
    })
  })
})
