import { describe, expect, it } from 'vitest'
import { buildWbs, canReparent } from './wbs'

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
