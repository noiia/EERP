import { describe, expect, it } from 'vitest'
import { addBlock, applyGeometry, removeBlock, updateConfig } from './layout-ops'

describe('layout ops', () => {
  it('adds below the lowest block with the type defaults', () => {
    const one = addBlock([], 'text')
    const two = addBlock(one, 'record_list')
    expect(two[1]).toMatchObject({ type: 'record_list', x: 0, y: 2, w: 12, h: 6 })
    expect(new Set(two.map((b) => b.id)).size).toBe(2)
  })
  it('applies drag/resize geometry by id and ignores unknown ids', () => {
    const l = addBlock([], 'text')
    const moved = applyGeometry(l, [{ i: l[0].id, x: 3, y: 1, w: 6, h: 3 }, { i: 'ghost', x: 0, y: 0, w: 1, h: 1 }])
    expect(moved).toEqual([{ ...l[0], x: 3, y: 1, w: 6, h: 3 }])
  })
  it('removes and reconfigures', () => {
    const l = addBlock(addBlock([], 'text'), 'hero')
    expect(removeBlock(l, l[0].id).map((b) => b.id)).toEqual([l[1].id])
    expect(updateConfig(l, l[1].id, { title: 'Hi' })[1].config).toEqual({ title: 'Hi' })
  })
})
