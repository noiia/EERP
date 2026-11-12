import { describe, expect, it } from 'vitest'
import { layoutPert, layoutWbs } from './auto-layout'
import { overlaps } from './collide'
import { buildWbs } from './wbs'

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const size = { w: 120, h: 40 }
const noOverlap = (pos: Record<string, { x: number; y: number }>) => {
  const ids = Object.keys(pos)
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      expect(overlaps({ ...pos[ids[i]], ...size }, { ...pos[ids[j]], ...size }, 0)).toBe(false)
}

describe('layoutWbs', () => {
  const rnd = mulberry32(7)
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, parentId: i && rnd() < 0.8 ? `t${Math.floor(rnd() * i)}` : null }))
  const { nodes, roots, visible } = buildWbs(rows, new Set())
  const pos = layoutWbs(nodes, roots, visible, size)
  it('no two boxes overlap', () => { expect(Object.keys(pos)).toHaveLength(50); noOverlap(pos) })
  it('children below parent, parent centered over children', () => {
    for (const id of visible) {
      const kids = nodes[id].children.filter((c) => visible.includes(c))
      if (!kids.length) continue
      for (const k of kids) expect(pos[k].y).toBeGreaterThan(pos[id].y)
      const xs = kids.map((k) => pos[k].x)
      expect(pos[id].x).toBeCloseTo((Math.min(...xs) + Math.max(...xs)) / 2, 5)
    }
  })
})

describe('layoutWbs with a short group row', () => {
  it('keeps the same gap under a short group box as between task rows', () => {
    const rows = [
      { id: 'a', parentId: null, groupId: 'p' },
      { id: 'b', parentId: 'a', groupId: 'p' },
    ]
    const { nodes, roots, visible } = buildWbs(rows, new Set())
    const heightOf = (id: string) => (nodes[id].kind === 'group' ? 60 : 300)
    const pos = layoutWbs(nodes, roots, visible, { w: 240, h: 300 }, heightOf)
    const g = roots[0]
    expect(pos.a.y - (pos[g].y + 60)).toBe(pos.b.y - (pos.a.y + 300))
  })
})

describe('layoutPert', () => {
  const rnd = mulberry32(11)
  const ids = Array.from({ length: 50 }, (_, i) => `n${i}`)
  const links = Array.from({ length: 80 }, () => {
    const a = Math.floor(rnd() * 49)
    return { from: ids[a], to: ids[a + 1 + Math.floor(rnd() * (49 - a))] }
  })
  it('no overlap, dependent right of blocker', () => {
    const pos = layoutPert(ids, links, size)
    noOverlap(pos)
    for (const l of links) expect(pos[l.to].x).toBeGreaterThan(pos[l.from].x)
  })
  it('positions every id on a cycle and ignores foreign links', () => {
    const pos = layoutPert(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'x', to: 'c' }], size)
    expect(Object.keys(pos).sort()).toEqual(['a', 'b', 'c'])
    noOverlap(pos)
  })
})
