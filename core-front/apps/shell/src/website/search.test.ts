import { describe, expect, it, vi } from 'vitest'
import { clampLimit, findSearchBlock, runSearch, type PublicList } from './search'
import type { Block } from './types'

const rows: Record<string, Record<string, unknown>[]> = {
  name: [{ id: 'p2', name: 'Zeta chair', picture: true }, { id: 'p1', name: 'Alpha chair', picture: false }],
  description: [{ id: 'p1', name: 'Alpha chair' }, { id: 'p3', name: 'Beta stool' }],
}

describe('runSearch', () => {
  it('searches each column apart, merges by id, sorts by title and builds links', async () => {
    const list = vi.fn<PublicList>(async (path) => {
      if (path.startsWith('/event')) return null // unpublished table: left out
      const col = [...new URLSearchParams(path.split('?')[1]).keys()].find((k) => k.startsWith('search['))!.slice(7, -1)
      return rows[col]
    })
    const groups = await runSearch({
      limit: 5,
      targets: [
        { table: 'product', title_field: 'name', label: 'Products', search_fields: ['name', 'description'], picture_field: 'picture', detail_slug: 'item' },
        { table: 'event', title_field: 'name' },
      ],
    }, '  chair ', list)
    expect(groups).toEqual([{
      table: 'product', label: 'Products', hits: [
        { id: 'p1', title: 'Alpha chair', href: '/item/p1', picture: undefined },
        { id: 'p3', title: 'Beta stool', href: '/item/p3', picture: '/api/v1/public/product/p3/picture/picture' },
        { id: 'p2', title: 'Zeta chair', href: '/item/p2', picture: '/api/v1/public/product/p2/picture/picture' },
      ],
    }])
    const first = new URLSearchParams(list.mock.calls[0][0].split('?')[1])
    expect(first.get('search[name]')).toBe('chair')
    expect(first.get('order')).toBe('name')
    expect(first.get('page_size')).toBe('5')
  })

  it('searches the title field by default and ignores short queries', async () => {
    const list = vi.fn<PublicList>(async () => [])
    expect(await runSearch({ targets: [{ table: 'contact', title_field: 'name' }] }, 'a', list)).toEqual([])
    expect(list).not.toHaveBeenCalled()
    await runSearch({ targets: [{ table: 'contact', title_field: 'name' }] }, 'an', list)
    expect(list.mock.calls[0][0]).toContain('search%5Bname%5D=an')
  })

  it('clamps the per-table limit', () => {
    expect(clampLimit(undefined)).toBe(5)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(99)).toBe(20)
  })
})

describe('findSearchBlock', () => {
  const layout: Block[] = [
    { id: 'a', type: 'text', x: 0, y: 0, w: 1, h: 1, config: {} },
    { id: 's', type: 'search', x: 0, y: 0, w: 1, h: 1, config: { targets: [] } },
  ]
  it('finds only a search block by id', () => {
    expect(findSearchBlock(layout, 's')).toEqual({ targets: [] })
    expect(findSearchBlock(layout, 'a')).toBeNull()
    expect(findSearchBlock(null, 's')).toBeNull()
  })
})
