import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

const { notFound, loadSearchBlock, list } = vi.hoisted(() => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
  loadSearchBlock: vi.fn(),
  list: vi.fn(),
}))
vi.mock('next/navigation', () => ({ notFound, useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/website/public-api', () => ({ serverPublicSource: { list: async () => null, get: async () => null } }))
vi.mock('@/website/present', () => ({ presentFields: async () => ({ columns: [] }) }))
vi.mock('@/website/search-server', () => ({ loadSearchBlock, publicSearchList: async () => list }))

import SearchPage from './page'

const open = (sp: Record<string, string>) => SearchPage({ searchParams: Promise.resolve(sp) })

describe('/search', () => {
  beforeEach(() => { loadSearchBlock.mockReset(); list.mockReset() })

  it("lists every result, one record list per table of the page's block", async () => {
    loadSearchBlock.mockResolvedValue({ limit: 2, targets: [
      { table: 'product', title_field: 'name', label: 'Products', detail_slug: 'item' },
      { table: 'event', title_field: 'name' },
    ] })
    list.mockImplementation(async (path: string) => (path.startsWith('/product') ? [{ id: 'p1', name: 'Red chair' }] : []))
    render(await open({ q: 'chair', page: 'pg', block: 's1' }))
    expect(loadSearchBlock).toHaveBeenCalledWith('pg', 's1')
    expect(list.mock.calls[0][0]).toContain('page_size=100')
    const section = screen.getByRole('region', { name: 'Products' })
    expect(within(section).getByText('Red chair').closest('a')).toHaveAttribute('href', '/item/p1')
    expect(screen.queryByRole('region', { name: 'event' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Search' })).toHaveValue('chair')
  })

  it('says so when nothing matches', async () => {
    loadSearchBlock.mockResolvedValue({ targets: [{ table: 'product', title_field: 'name' }] })
    list.mockResolvedValue([])
    render(await open({ q: 'zzz', page: 'pg', block: 's1' }))
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('404s without a published search block', async () => {
    loadSearchBlock.mockResolvedValue(null)
    await expect(open({ q: 'x', page: 'pg', block: 'nope' })).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(open({ q: 'x' })).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
