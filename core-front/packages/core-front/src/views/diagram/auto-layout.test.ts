import { describe, expect, it } from 'vitest'
import { GRID_TRUNK_GAP, layoutPert, layoutTreeGrid, layoutWbs, PERT_UNLINKED_ROWS, layoutRectangle, treeGridEdges } from './auto-layout'
import { bezierPoint, overlaps } from './collide'
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

describe('layoutPert with order numbers', () => {
  it('starts with the 1.x records and ends with the highest, dependencies still first', () => {
    const size = { w: 100, h: 50 }
    const order: Record<string, string> = { a: '2', b: '1.1', c: '1', d: '3', e: '2.1' }
    const pos = layoutPert(['a', 'b', 'c', 'd', 'e'], [{ from: 'd', to: 'a' }], size, (id) => order[id])
    expect(pos.b.x).toBe(pos.c.x)
    expect(pos.c.x).toBeLessThan(pos.e.x)
    expect(pos.d.x).toBeLessThan(pos.a.x) // d blocks a, whatever their numbers
  })
})

describe('layoutPert parts', () => {
  const center = (pos: Record<string, { y: number }>, ids: string[]) => {
    const ys = ids.map((i) => pos[i].y)
    return (Math.min(...ys) + Math.max(...ys) + size.h) / 2
  }
  it('lays linked records out on the left, unlinked ones to their right', () => {
    const pos = layoutPert(['u1', 'a', 'u2', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }], size)
    noOverlap(pos)
    const linkedRight = Math.max(pos.a.x, pos.b.x, pos.c.x)
    expect(pos.u1.x).toBeGreaterThan(linkedRight)
    expect(pos.u1.x).toBe(pos.u2.x) // one column without order numbers
    expect(pos.a.x).toBe(0)
  })

  it('inlines boxes with their blockers, a fork centered on its blocker', () => {
    // a → b, a → c, b → d: [a], [b, c], [d]; unlinked u1..u3 in one column.
    const pos = layoutPert(['a', 'b', 'c', 'd', 'u1', 'u2', 'u3'], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }], size)
    noOverlap(pos)
    expect(center(pos, ['b', 'c'])).toBeCloseTo(center(pos, ['a']), 5)
    expect(pos.d.y).toBe(pos.b.y) // straight b → d
    const ys = ['a', 'b', 'c', 'd'].map((i) => pos[i].y)
    expect(center(pos, ['u1', 'u2', 'u3'])).toBeCloseTo((Math.min(...ys) + Math.max(...ys) + size.h) / 2, 5)
  })

  it('draws a chain as one straight line, one 5-dot gap apart', () => {
    const pos = layoutPert(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], size)
    expect(new Set(['a', 'b', 'c'].map((i) => pos[i].y)).size).toBe(1)
    expect(pos.b.x - (pos.a.x + size.w)).toBe(100)
    expect(pos.c.x - (pos.b.x + size.w)).toBe(100)
  })

  it('moves a box next to its dependent when that shortens its arrows', () => {
    // a → b → c → d and s → d: s starts in d's column - 1, inline with d, instead of column 0.
    const pos = layoutPert(['a', 'b', 'c', 'd', 's'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 's', to: 'd' }], size)
    noOverlap(pos)
    expect(pos.s.x).toBe(pos.c.x)
    // A box with as many blockers as dependents stays where its blockers put it.
    const pos2 = layoutPert(['a', 'b', 'c', 'x', 'y', 'z'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'x', to: 'y' }, { from: 'y', to: 'c' }, { from: 'z', to: 'c' }], size)
    expect(pos2.y.x).toBe(pos2.a.x + (pos2.b.x - pos2.a.x))
    expect(pos2.z.x).toBe(pos2.b.x)
  })

  it('stacks separate linked groups without mixing them', () => {
    const pos = layoutPert(['a', 'b', 'x', 'y'], [{ from: 'a', to: 'b' }, { from: 'x', to: 'y' }], size)
    noOverlap(pos)
    expect(pos.a.y).toBe(pos.b.y)
    expect(pos.x.y).toBe(pos.y.y)
    expect(pos.x.y).toBeGreaterThan(pos.a.y)
    expect(pos.x.x).toBe(0)
  })

  it('splits unlinked records into their order-number columns', () => {
    const order: Record<string, string> = { a: '1', b: '1.1', c: '2', d: '3', e: '3.2' }
    const pos = layoutPert(['a', 'b', 'c', 'd', 'e'], [{ from: 'c', to: 'd' }], size, (id) => order[id])
    expect(pos.c.x).toBeLessThan(pos.d.x)
    expect(pos.a.x).toBe(pos.b.x)
    expect(pos.e.x).toBeGreaterThan(pos.a.x)
    expect(pos.a.x).toBeGreaterThan(pos.d.x)
  })
  it('wraps a long unlinked column every PERT_UNLINKED_ROWS records, in order', () => {
    const ids = Array.from({ length: 2 * PERT_UNLINKED_ROWS + 3 }, (_, i) => `u${i}`)
    const pos = layoutPert(ids, [], size)
    noOverlap(pos)
    const xs = [...new Set(ids.map((i) => pos[i].x))]
    expect(xs).toHaveLength(3)
    expect(ids.filter((i) => pos[i].x === xs[0])).toEqual(ids.slice(0, PERT_UNLINKED_ROWS))
    expect(ids.filter((i) => pos[i].x === xs[2])).toHaveLength(3)
    expect(xs[0]).toBe(0)
  })
  it('moves boxes off the arrows passing behind them', () => {
    // a → b → c plus a → c: the a → c arrow runs straight through b, alone in the middle column.
    // Also a → d, d → e, b → e and a → e: several long arrows over a fuller column.
    const cases: [string[], { from: string; to: string }[]][] = [
      [['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }]],
      [['a', 'b', 'c', 'd', 'e'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }, { from: 'a', to: 'd' }, { from: 'd', to: 'e' }, { from: 'c', to: 'e' }, { from: 'a', to: 'e' }]],
    ]
    for (const [ids, links] of cases) {
      const pos = layoutPert(ids, links, size)
      noOverlap(pos)
      for (const l of links) {
        const s = { x: pos[l.from].x + size.w, y: pos[l.from].y + size.h / 2 }
        const t = { x: pos[l.to].x, y: pos[l.to].y + size.h / 2 }
        for (const id of ids) {
          if (id === l.from || id === l.to) continue
          for (let i = 0; i <= 64; i++) {
            const p = bezierPoint(s, t, i / 64)
            const inside = p.x > pos[id].x && p.x < pos[id].x + size.w && p.y > pos[id].y && p.y < pos[id].y + size.h
            expect(inside, `${l.from}→${l.to} behind ${id}`).toBe(false)
          }
        }
      }
    }
  })
})

describe('layoutWbs with stacked children', () => {
  // 1 → 1.1 → (1.1.1, 1.1.2 → 1.1.2.1), 1 → 1.2 → 1.2.1: level 3 and below stack.
  const rows = [
    { id: '1', parentId: null },
    { id: '1.1', parentId: '1' },
    { id: '1.1.1', parentId: '1.1' },
    { id: '1.1.2', parentId: '1.1' },
    { id: '1.1.2.1', parentId: '1.1.2' },
    { id: '1.2', parentId: '1' },
    { id: '1.2.1', parentId: '1.2' },
  ]
  const { nodes, roots, visible } = buildWbs(rows, new Set())
  const pos = layoutWbs(nodes, roots, visible, size, undefined, (id) => id.split('.').length >= 3)
  it('stacks them in an indented column under their parent', () => {
    expect(pos['1.1.1'].x).toBe(pos['1.1'].x + 40)
    expect(pos['1.1.2'].x).toBe(pos['1.1.1'].x)
    expect(pos['1.1.2.1'].x).toBe(pos['1.1.2'].x + 40)
    expect(pos['1.1.1'].y).toBeGreaterThan(pos['1.1'].y + size.h)
    expect(pos['1.1.2'].y).toBeGreaterThan(pos['1.1.1'].y + size.h)
    expect(pos['1.1.2.1'].y).toBeGreaterThan(pos['1.1.2'].y + size.h)
  })
  it('keeps level 2 in one row, widened for the columns, without overlap', () => {
    expect(pos['1.2'].y).toBe(pos['1.1'].y)
    expect(pos['1.2'].x).toBeGreaterThanOrEqual(pos['1.1'].x + size.w + 80)
    noOverlap(pos)
  })
})

describe('layoutTreeGrid', () => {
  const tree = (rows: [string, string | null][]) => buildWbs(rows.map(([id, parentId]) => ({ id, parentId })), new Set())

  it('up to 3 children sit side by side under their centered parent', () => {
    const { nodes, roots, visible } = tree([['p', null], ['a', 'p'], ['b', 'p'], ['c', 'p']])
    const pos = layoutTreeGrid(nodes, roots, visible, size)
    expect(pos.a.y).toBe(pos.b.y)
    expect(pos.c.y).toBe(pos.b.y)
    expect(pos.b.x).toBeGreaterThan(pos.a.x)
    expect(pos.p.x).toBe((pos.a.x + pos.c.x) / 2)
    noOverlap(pos)
  })

  it('below level 2, more than 3 children go in a balanced grid of ceil(sqrt(n)) columns, the parent centered over it', () => {
    const kids = Array.from({ length: 7 }, (_, i) => `k${i}`)
    const { nodes, roots, visible } = tree([['r', null], ['p', 'r'], ...kids.map((k): [string, string] => [k, 'p'])])
    const pos = layoutTreeGrid(nodes, roots, visible, size)
    const xs = [...new Set(kids.map((k) => pos[k].x))]
    const ys = [...new Set(kids.map((k) => pos[k].y))]
    expect(xs).toHaveLength(3) // ceil(sqrt(7))
    expect(ys).toHaveLength(3)
    // Row by row, in order.
    expect(pos.k1.y).toBe(pos.k0.y)
    expect(pos.k3.x).toBe(pos.k0.x)
    expect(pos.k3.y).toBeGreaterThan(pos.k0.y)
    // Room for the trunk line left of each column.
    expect(pos.k1.x - (pos.k0.x + size.w)).toBeGreaterThanOrEqual(2 * GRID_TRUNK_GAP)
    expect(pos.p.x + size.w / 2).toBe((Math.min(...xs) + Math.max(...xs) + size.w) / 2)
    noOverlap(pos)
  })

  it('levels 1 and 2 each share one row, however many boxes; deeper families stay in grids', () => {
    const rows: [string, string | null][] = [['ceo', null], ['coo', null]]
    for (let m = 0; m < 5; m++) {
      rows.push([`m${m}`, m < 4 ? 'ceo' : 'coo'])
      for (let p = 0; p < (m === 2 ? 1 : 5); p++) rows.push([`p${m}.${p}`, `m${m}`])
    }
    const { nodes, roots, visible } = tree(rows)
    const pos = layoutTreeGrid(nodes, roots, visible, size)
    expect(pos.coo.y).toBe(pos.ceo.y)
    expect(new Set([0, 1, 2, 3, 4].map((m) => pos[`m${m}`].y)).size).toBe(1)
    // The managers side by side, in order.
    for (let m = 1; m < 5; m++) expect(pos[`m${m}`].x).toBeGreaterThan(pos[`m${m - 1}`].x)
    // People are a 3-column grid under their manager, not one vertical column.
    expect(new Set([0, 1, 2, 3, 4].map((p) => pos[`p0.${p}`].x)).size).toBe(3)
    expect(new Set([0, 1, 2, 3, 4].map((p) => pos[`p0.${p}`].y)).size).toBe(2)
    noOverlap(pos)
  })

  it('places several roots side by side', () => {
    const { nodes, roots, visible } = tree([['r1', null], ['r2', null]])
    const pos = layoutTreeGrid(nodes, roots, visible, size)
    expect(pos.r2.y).toBe(pos.r1.y)
    expect(pos.r2.x).toBeGreaterThanOrEqual(pos.r1.x + size.w)
  })
})

describe('treeGridEdges', () => {
  it('enters a grid child from the left by a bus whose trunk clears its subtree; root children and small families from the top', () => {
    const rows = [
      { id: 'r', parent_id: null }, { id: 'p', parent_id: 'r' }, { id: 'q', parent_id: 'r' }, { id: 'x', parent_id: 'r' }, { id: 'y', parent_id: 'r' },
      ...[0, 1, 2, 3].map((i) => ({ id: `k${i}`, parent_id: 'p' })), { id: 'g', parent_id: 'k0' },
    ]
    const lines = treeGridEdges(rows, { k0: { x: 100, y: 0 }, g: { x: 60, y: 0 } })
    expect(lines.edge('p')).toEqual({ type: 'smoothstep' })
    expect(lines.edge('g')).toEqual({ type: 'smoothstep' })
    expect(lines.edge('k0')).toEqual({ type: 'bus', data: { trunk: 40 + GRID_TRUNK_GAP } })
    expect(lines.inGrid('k3')).toBe(true)
  })
})

describe('layoutRectangle', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)
  const grid = (n: number) => {
    const pos = layoutRectangle(ids(n), size)
    return { pos, cols: new Set(Object.values(pos).map((p) => p.x)).size, lines: new Set(Object.values(pos).map((p) => p.y)).size }
  }
  it('keeps a short chain on one line', () => {
    expect(grid(3)).toMatchObject({ cols: 3, lines: 1 })
    expect(grid(0).pos).toEqual({})
  })
  it('folds 12 boxes into 4 columns of 3 lines, first top-left, last bottom-right', () => {
    const { pos, cols, lines } = grid(12)
    expect([cols, lines]).toEqual([4, 3])
    const xs = Object.values(pos).map((p) => p.x)
    const ys = Object.values(pos).map((p) => p.y)
    expect(pos.t0).toEqual({ x: Math.min(...xs), y: Math.min(...ys) })
    expect(pos.t11).toEqual({ x: Math.max(...xs), y: Math.max(...ys) })
    expect(pos.t4.y).toBeGreaterThan(pos.t3.y)
    noOverlap(pos)
  })
  it('right-aligns a short last line so the last box still ends bottom-right', () => {
    const { pos } = grid(9) // 4 columns: 4, 4, 1
    expect(pos.t8.x).toBe(pos.t7.x)
    expect(pos.t8.y).toBeGreaterThan(pos.t7.y)
  })
})
