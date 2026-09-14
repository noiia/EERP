import { describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE } from './palette'
import { elevation, focusRing, layout, neutral, radius, withAlpha } from './tokens'

describe('design tokens', () => {
  it('neutral ramp is a superset of the brand greys (anchors line up)', () => {
    // The neutrals must not be a second, competing grey scale — the 50/500/800 stops
    // are exactly Soft White / Steel Grey / Deep Ocean.
    expect(neutral[50]).toBe(DEFAULT_PALETTE.softWhite)
    expect(neutral[500]).toBe(DEFAULT_PALETTE.steelGrey)
    expect(neutral[800]).toBe(DEFAULT_PALETTE.deepOcean)
  })

  it('uses an 8px corner radius for direction B', () => {
    expect(radius.md).toBe(8)
  })

  it('ships a 3-step elevation tier', () => {
    expect(elevation.card).not.toBe('none')
    expect(elevation.overlay).not.toBe(elevation.card)
    expect(elevation.header).toContain('rgba(15,23,42')
  })

  it('exposes layout measures the renderers consume', () => {
    expect(layout.formMaxWidth).toBeGreaterThan(0)
    expect(layout.gridRowHeight).toBeGreaterThan(0)
  })

  it('exposes a single page-content inset, one value per axis', () => {
    // RootLayout applies these ONCE, around everything but the top bar — a view
    // (list/form/dashboard) must never re-derive its own width/margin constant.
    expect(layout.pageInsetX).toBe('5vw')
    expect(layout.pageInsetY).toBe('5vh')
  })

  it('withAlpha expands hex (incl. shorthand) to rgba', () => {
    expect(withAlpha('#1E293B', 0.5)).toBe('rgba(30, 41, 59, 0.5)')
    expect(withAlpha('#fff', 0.12)).toBe('rgba(255, 255, 255, 0.12)')
  })

  it('focusRing builds a 3px ring in the given color', () => {
    expect(focusRing('#00ADD8')).toBe('0 0 0 3px rgba(0, 173, 216, 0.4)')
  })
})
