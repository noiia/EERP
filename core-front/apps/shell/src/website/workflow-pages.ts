import 'server-only'
import { apiRequest } from '@eerp/core-front/server'
import type { Block } from './types'
import type { WfPage } from './workflow'

type Row = { id: string; slug: string | null; title: string | null; published: boolean | null; in_menu: boolean | null; layout: Block[] | null }

/** Every website page with its layout, read as staff (unpublished pages too) for the
 * workflow map. Uncached, so a map opened right after a save shows it. It pages, in a
 * stable order, until a page comes back empty: Go's total can be an estimate. */
export async function loadWorkflowPages(pageSize = 200): Promise<WfPage[]> {
  const pages: WfPage[] = []
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({ page: String(page), page_size: String(pageSize), order: 'id' })
    const rows = (await apiRequest<{ data?: Row[] }>('GET', `/website_page?${q}`)).data ?? []
    if (rows.length === 0) return pages
    for (const r of rows) {
      pages.push({ id: r.id, slug: r.slug ?? '', title: r.title ?? '', published: !!r.published, in_menu: !!r.in_menu, layout: r.layout ?? [] })
    }
  }
}
