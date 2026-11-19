import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eerp/core-front/server')>()),
  apiRequest: (...a: unknown[]) => apiRequestMock(...a),
}))

import { loadWorkflowPages } from './workflow-pages'

const row = (i: number) => ({ id: `p${i}`, slug: `s${i}`, title: `T${i}`, published: i % 2 === 0 ? true : null, in_menu: null, layout: i === 0 ? null : [] })

beforeEach(() => apiRequestMock.mockReset())

describe('loadWorkflowPages', () => {
  it('pages through every website page until an empty page, ignoring the total', async () => {
    apiRequestMock
      .mockResolvedValueOnce({ data: [row(0), row(1)], total: 2, total_estimated: true })
      .mockResolvedValueOnce({ data: [row(2)], total: 2 })
      .mockResolvedValueOnce({ data: [], total: 2 })
    const pages = await loadWorkflowPages(2)
    expect(pages.map((p) => p.id)).toEqual(['p0', 'p1', 'p2'])
    expect(pages[0]).toEqual({ id: 'p0', slug: 's0', title: 'T0', published: true, in_menu: false, layout: [] })
    expect(pages[1].published).toBe(false)
    expect(apiRequestMock.mock.calls.map((c) => c[1])).toEqual([
      '/website_page?page=1&page_size=2&order=id',
      '/website_page?page=2&page_size=2&order=id',
      '/website_page?page=3&page_size=2&order=id',
    ])
  })
})
