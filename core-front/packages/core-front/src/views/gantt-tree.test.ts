import { describe, expect, it } from 'vitest'
import { ganttTree } from './gantt-tree'

type R = { id: string; p: string | null }
const run = (rows: R[], collapsed: string[] = []) =>
  ganttTree(rows, (r) => r.id, (r) => r.p, new Set(collapsed)).map((t) => `${'-'.repeat(t.depth)}${t.row.id}${t.hasChildren ? '+' : ''}`)

describe('ganttTree', () => {
  const rows: R[] = [{ id: 'b', p: 'a' }, { id: 'a', p: null }, { id: 'c', p: 'b' }, { id: 'd', p: null }, { id: 'e', p: 'gone' }]
  it('nests children under their parent, keeping sibling order; a missing parent makes a root', () => {
    expect(run(rows)).toEqual(['a+', '-b+', '--c', 'd', 'e'])
  })
  it('hides every descendant of a collapsed row, which keeps its chevron', () => {
    expect(run(rows, ['a'])).toEqual(['a+', 'd', 'e'])
    expect(run(rows, ['b'])).toEqual(['a+', '-b+', 'd', 'e'])
  })
  it('survives a parent cycle', () => {
    expect(run([{ id: 'x', p: 'y' }, { id: 'y', p: 'x' }])).toHaveLength(2)
  })
})
