import { describe, expect, it } from 'vitest'
import { bezierPoint, freeSpot, labelSize, overlaps, placeLabels, segmentHitsRect, separateBoxes, type Rect } from './collide'

const r = (x: number, y: number, w = 100, h = 40): Rect => ({ x, y, w, h })

describe('overlaps', () => {
  it('detects overlap, honoring the gap', () => {
    expect(overlaps(r(0, 0), r(50, 10))).toBe(true)
    expect(overlaps(r(0, 0), r(110, 0))).toBe(false)
    expect(overlaps(r(0, 0), r(110, 0), 16)).toBe(true)
  })
})

describe('freeSpot', () => {
  it('keeps a position that is already clear', () => {
    expect(freeSpot(r(0, 0), [r(300, 300)])).toEqual({ x: 0, y: 0 })
  })

  it('moves an overlapping box to the nearest clear spot', () => {
    const others = [r(0, 0)]
    const p = freeSpot(r(10, 10), others)
    expect(others.some((o) => overlaps({ ...r(0, 0), ...p }, o, 16))).toBe(false)
    expect(Math.hypot(p.x - 10, p.y - 10)).toBeLessThan(120)
  })
})

describe('separateBoxes', () => {
  it('keeps fixed boxes and moves the automatic ones off them', () => {
    const out = separateBoxes([
      { id: 'auto', ...r(0, 0) },
      { id: 'saved', ...r(0, 0), fixed: true },
    ])
    expect(out.saved).toEqual({ x: 0, y: 0 })
    expect(overlaps({ ...r(0, 0), ...out.auto }, r(0, 0), 16)).toBe(false)
  })
})

describe('bezierPoint', () => {
  it('starts at the source, ends at the target, and passes the middle at t=0.5', () => {
    const s = { x: 0, y: 0 }, t = { x: 200, y: 100 }
    expect(bezierPoint(s, t, 0)).toEqual(s)
    expect(bezierPoint(s, t, 1)).toEqual(t)
    expect(bezierPoint(s, t, 0.5)).toEqual({ x: 100, y: 50 })
  })
})

describe('placeLabels', () => {
  const size = labelSize('Go')

  it('keeps a lone label in the middle of its arrow', () => {
    expect(placeLabels([{ id: 'a', source: { x: 0, y: 0 }, target: { x: 300, y: 0 }, ...size }], [])).toEqual({ a: { t: 0.5, dy: 0 } })
  })

  it('moves the second of two labels that would sit on the same spot', () => {
    const arrow = { source: { x: 0, y: 0 }, target: { x: 300, y: 0 }, ...size }
    const out = placeLabels([{ id: 'a', ...arrow }, { id: 'b', ...arrow }], [])
    expect(out.a).toEqual({ t: 0.5, dy: 0 })
    expect(out.b).not.toEqual(out.a)
  })

  it('slides a label off a box lying on its arrow', () => {
    const out = placeLabels([{ id: 'a', source: { x: 0, y: 0 }, target: { x: 300, y: 0 }, ...size }], [r(130, -20, 40, 40)])
    expect(out.a).not.toEqual({ t: 0.5, dy: 0 })
  })
})

describe('segmentHitsRect', () => {
  const r = { x: 10, y: 10, w: 10, h: 10 }
  it.each([
    ['crosses it', { x: 0, y: 15 }, { x: 30, y: 15 }, true],
    ['starts inside', { x: 15, y: 15 }, { x: 50, y: 50 }, true],
    ['passes above', { x: 0, y: 5 }, { x: 30, y: 5 }, false],
    ['stops short', { x: 0, y: 15 }, { x: 5, y: 15 }, false],
    ['diagonal miss', { x: 0, y: 30 }, { x: 30, y: 25 }, false],
    ['vertical through', { x: 15, y: 0 }, { x: 15, y: 30 }, true],
  ])('%s', (_name, a, b, hit) => expect(segmentHitsRect(a, b, r)).toBe(hit))
})
