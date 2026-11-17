import { describe, expect, it } from 'vitest'
import { buildWbs, canReparent, compareOrder, wbsColumnDeliverables } from './wbs'

const chain = [
  { id: 'a', parentId: null, plannedHours: 1 },
  { id: 'b', parentId: 'a', plannedHours: 2 },
  { id: 'c', parentId: 'b', plannedHours: 4 },
  { id: 'd', parentId: 'a', plannedHours: null },
]

describe('buildWbs', () => {
  it('groups by project', () => {
    const r = buildWbs([
      { id: 't1', parentId: null, groupId: 'p1', groupLabel: 'P1' },
      { id: 't2', parentId: null, groupId: 'p2', groupLabel: 'P2' },
    ], new Set())
    expect(r.roots).toEqual(['group:p1', 'group:p2'])
    expect(r.nodes['group:p1']).toMatchObject({ kind: 'group', children: ['t1'], depth: 0 })
    expect(r.nodes.t1.depth).toBe(1)
    expect(r.visible).toEqual(['group:p1', 't1', 'group:p2', 't2'])
  })

  it('orphan parent filtered out: child under its group, or root without groups', () => {
    const g = buildWbs([{ id: 't', parentId: 'gone', groupId: 'p' }], new Set())
    expect(g.nodes.t.parentId).toBe('group:p')
    expect(buildWbs([{ id: 't', parentId: 'gone' }], new Set()).roots).toEqual(['t'])
  })

  it('fold hides the whole subtree and rolls up count and hours', () => {
    const r = buildWbs(chain, new Set(['a']))
    expect(r.visible).toEqual(['a'])
    expect(r.nodes.a).toMatchObject({ hiddenCount: 3, hiddenHours: 6 })
    const m = buildWbs(chain, new Set(['b']))
    expect(m.visible).toEqual(['a', 'b', 'd'])
    expect(m.nodes.b).toMatchObject({ hiddenCount: 1, hiddenHours: 4 })
    expect(m.nodes.d.hiddenCount).toBe(0)
  })

  it('survives parent cycles', () => {
    const r = buildWbs([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }], new Set())
    expect(r.visible).toHaveLength(2)
  })
})

describe('canReparent', () => {
  const { nodes } = buildWbs(chain, new Set())
  it('refuses self and descendants', () => {
    expect(canReparent(nodes, 'b', 'b')).toBe(false)
    expect(canReparent(nodes, 'a', 'c')).toBe(false)
    expect(canReparent(nodes, 'c', 'd')).toBe(true)
    expect(canReparent(nodes, 'b', 'd')).toBe(true)
  })
  it('group id clears the parent; unknown ids refused', () => {
    expect(canReparent(nodes, 'b', 'group:p')).toBe(true)
    expect(canReparent(nodes, 'b', null)).toBe(true)
    expect(canReparent(nodes, 'zz', 'a')).toBe(false)
    expect(canReparent(nodes, 'b', 'zz')).toBe(false)
    expect(canReparent(nodes, 'group:p', 'a')).toBe(false)
  })
})

describe('wbsColumnDeliverables', () => {
  const rows = [
    { id: 'r', parentId: null, order: '1' },
    { id: 'c1', parentId: 'r', order: '1.1' },
    { id: 'c2', parentId: 'r', order: '1.2' },
    { id: 'd1', parentId: 'c1', order: '1.1.1' },
    { id: 'd2', parentId: 'c1', order: '1.1.2' },
    { id: 'd3', parentId: 'c2', order: '1.2.1' },
    { id: 'e1', parentId: 'd1', order: '1.1.1.1' },
  ]
  const itemOf = (map: Record<string, string>) => (id: string) => map[id] ?? null

  it('dedupes each column to the first-seen items in WBS order', () => {
    const { nodes } = buildWbs(rows, new Set())
    const got = wbsColumnDeliverables(nodes, rows, itemOf({ c1: 'A', d1: 'B', d2: 'A', c2: 'C', d3: 'C' }))
    expect(got.get('c1')).toEqual(['A', 'B'])
    expect(got.get('c2')).toEqual(['C'])
    expect([...got.keys()].sort()).toEqual(['c1', 'c2'])
  })

  it('counts a deep descendant under its level-2 ancestor', () => {
    const { nodes } = buildWbs(rows, new Set())
    const got = wbsColumnDeliverables(nodes, rows, itemOf({ c1: 'A', e1: 'Z' }))
    expect(got.get('c1')).toEqual(['A', 'Z'])
  })

  it('still counts a folded subtree', () => {
    const r = buildWbs(rows, new Set(['c1']))
    expect(r.visible).not.toContain('d1')
    const got = wbsColumnDeliverables(r.nodes, rows, itemOf({ c1: 'A', d1: 'B', e1: 'Z' }))
    expect(got.get('c1')).toEqual(['A', 'B', 'Z'])
  })

  it('a task with no parent and no group is its own column', () => {
    const input = [{ id: 's', parentId: null, order: '5' }]
    const { nodes } = buildWbs(input, new Set())
    const got = wbsColumnDeliverables(nodes, input, itemOf({ s: 'X' }))
    expect(got.get('s')).toEqual(['X'])
  })

  it('ignores tasks that are not in the given rows', () => {
    const input = [{ id: 'c1', parentId: null, order: '1' }, { id: 't9', parentId: 'c1', order: '1.1' }]
    const { nodes } = buildWbs(input, new Set())
    const got = wbsColumnDeliverables(nodes, [input[0]], itemOf({ c1: 'A', t9: 'Q' }))
    expect(got.get('c1')).toEqual(['A'])
  })
})

describe('order numbers', () => {
  it('compares segment by segment, unnumbered last', () => {
    expect(['2.10', '10', '2.9', '', '2', '1.1'].sort((a, b) => compareOrder(a || null, b || null))).toEqual(['1.1', '2', '2.9', '2.10', '10', ''])
  })
  it('orders siblings by number', () => {
    const { nodes, roots } = buildWbs(
      [{ id: 'b', parentId: null, order: '2' }, { id: 'a', parentId: null, order: '1' }, { id: 'a2', parentId: 'a', order: '1.2' }, { id: 'a1', parentId: 'a', order: '1.1' }],
      new Set(),
    )
    expect(roots).toEqual(['a', 'b'])
    expect(nodes.a.children).toEqual(['a1', 'a2'])
  })
})
