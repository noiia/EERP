import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BlockView } from './BlockView'
import { stackOrder, type Block, type PublicDataSource } from '../types'

const source = (records: Record<string, unknown>[] | null): PublicDataSource => ({
  list: async () => (records ? { records, total: records.length } : null),
  get: async (_t, id) => records?.find((r) => r.id === id) ?? null,
})
const block = (type: Block['type'], config: Record<string, unknown>): Block => ({ id: 'b', type, x: 0, y: 0, w: 12, h: 2, config })

async function renderBlock(b: Block, s: PublicDataSource, params = {}) {
  return render(await BlockView({ block: b, source: s, params }))
}

describe('blocks', () => {
  it('text: heading + paragraphs', async () => {
    await renderBlock(block('text', { heading: 'Hello', body: 'One\n\nTwo' }), source([]))
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeTruthy()
    expect(screen.getByText('Two')).toBeTruthy()
  })

  it('hero: title and CTA link', async () => {
    await renderBlock(block('hero', { title: 'Welcome', cta_label: 'Go', cta_href: '/x' }), source([]))
    expect(screen.getByRole('heading', { name: 'Welcome' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go' }).getAttribute('href')).toBe('/x')
  })

  it('hero: a lone button renders no heading; size, width and alignment come from config', async () => {
    await renderBlock(block('hero', { title: '', cta_label: 'Book', cta_href: '/book', button_size: 'small', button_width: 'full', align: 'right' }), source([]))
    expect(screen.queryByRole('heading')).toBeNull()
    const btn = screen.getByRole('link', { name: 'Book' })
    expect(btn.className).toMatch(/sizeSmall/)
    expect(btn.className).toMatch(/fullWidth/)
  })

  it('hero and image drop unsafe links', async () => {
    await renderBlock(block('hero', { title: 'W', cta_label: 'Go', cta_href: 'javascript:alert(1)' }), source([]))
    expect(screen.queryByRole('link', { name: 'Go' })).toBeNull()
    await renderBlock(block('image', { table: 't', record: 'r', field: 'f', alt: 'Pic', href: '//evil.com' }), source([]))
    expect(screen.getByAltText('Pic').closest('a')).toBeNull()
  })

  it('image: an unconfigured block renders nothing (no /public///picture/ request)', async () => {
    const { container } = await renderBlock(block('image', {}), source([]))
    expect(container.querySelector('img')).toBeNull()
  })

  it('image: points at the public picture route', async () => {
    await renderBlock(block('image', { table: 'product', record: 'r1', field: 'photo', alt: 'A chair' }), source([]))
    expect(screen.getByAltText('A chair').getAttribute('src')).toBe('/api/v1/public/product/r1/picture/photo')
  })

  it('record_list renders only the fields present (unpublished field is absent, no crash)', async () => {
    const s = source([{ id: '1', name: 'Chair' }])
    await renderBlock(block('record_list', { table: 'product', fields: ['name', 'unit_price'], title_field: 'name', detail_slug: 'products' }), s)
    expect(screen.getByText('Chair')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Chair/ }).getAttribute('href')).toBe('/products/1')
    expect(screen.queryByText(/Unit price/)).toBeNull()
  })

  it('record_list skips structured values (a JSON layout has no one-line form)', async () => {
    await renderBlock(block('record_list', { table: 'website_page', fields: ['title', 'layout'], title_field: 'title' }), source([{ id: '1', title: 'Home', layout: [{ id: 'b' }] }]))
    expect(screen.queryByText(/object Object/)).toBeNull()
  })

  it('a picture only for an anchor or a true flag, never a number field', async () => {
    const s = source([{ id: '1', name: 'A', menu_sequence: 0, photo: false }, { id: '2', name: 'B', menu_sequence: 1, photo: true }])
    const { container } = await renderBlock(block('record_list', { table: 't', fields: ['name'], title_field: 'name', picture_field: 'menu_sequence' }), s)
    expect(container.querySelector('img')).toBeNull()
    const again = await renderBlock(block('record_list', { table: 't', fields: ['name'], title_field: 'name', picture_field: 'photo' }), s)
    expect(again.container.querySelectorAll('img')).toHaveLength(1)
  })

  it('record_detail with a fixed record ignores the URL id', async () => {
    const s = source([{ id: '7', name: 'Lamp' }, { id: '8', name: 'Desk' }])
    await renderBlock(block('record_detail', { table: 'product', fields: ['name'], title_field: 'name', record: '8' }), s, { id: '7' })
    expect(screen.getByRole('heading', { name: 'Desk' })).toBeTruthy()
  })

  it('record_carousel: picked records in their order, capped by limit; missing ones drop out', async () => {
    const s = source([{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }])
    await renderBlock(block('record_carousel', { table: 't', fields: [], title_field: 'name', records: ['3', 'gone', '1', '2'], limit: 3 }), s)
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['C', 'A'])
  })

  it('record_carousel: a right-side picture sits beside the text, at the configured width', async () => {
    const s = source([{ id: '1', name: 'A', photo: true }])
    await renderBlock(block('record_carousel', { table: 't', fields: [], title_field: 'name', picture_field: 'photo', records: ['1'], picture_position: 'right', picture_width: 30 }), s)
    const img = screen.getByRole('presentation') as HTMLImageElement
    expect(getComputedStyle(img.parentElement!).flexDirection).toBe('row-reverse')
    expect(getComputedStyle(img).width).toBe('30%')
  })

  it('record_carousel without picks shows the first `limit` records', async () => {
    const s: PublicDataSource = {
      list: async (_t, q) => ({ records: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }].slice(0, q.page_size), total: 2 }),
      get: async () => null,
    }
    await renderBlock(block('record_carousel', { table: 't', fields: [], title_field: 'name', limit: 1 }), s)
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['A'])
  })

  it('record_list: pages of 10 by default, visitor pages and switches grid → table', async () => {
    const recs = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `R${i}`, price: i }))
    await renderBlock(block('record_list', { table: 't', fields: ['name', 'price'], title_field: 'name', detail_slug: 'p' }), source(recs))
    expect(screen.getAllByRole('heading')).toHaveLength(10)
    fireEvent.click(screen.getByRole('button', { name: /page 3/ }))
    expect(screen.getAllByRole('heading')[0].textContent).toBe('R20')
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.getAllByRole('row')).toHaveLength(11) // header + 10
    expect(screen.getByRole('link', { name: 'R20' }).getAttribute('href')).toBe('/p/20')
    expect(screen.getByRole('columnheader', { name: 'Price' }).className).toBe('col-0')
  })

  it('record_list on an unpublished table renders nothing', async () => {
    const { container } = await renderBlock(block('record_list', { table: 'crm', fields: ['name'], title_field: 'name' }), source(null))
    expect(container.textContent).toBe('')
  })

  it('image_carousel shows one picture at a time, skips records without one, arrows cycle', async () => {
    const s = source([{ id: '1', name: 'A', picture: true }, { id: '2', name: 'B', picture: false }, { id: '3', name: 'C', picture: true }])
    await renderBlock(block('image_carousel', { table: 'product', picture_field: 'picture', title_field: 'name', detail_slug: 'p' }), s)
    expect(screen.getByAltText('A').getAttribute('src')).toBe('/api/v1/public/product/1/picture/picture')
    expect(screen.getByAltText('A').closest('a')?.getAttribute('href')).toBe('/p/1')
    fireEvent.click(screen.getByRole('button', { name: 'Next picture' }))
    expect(screen.getByAltText('C')).toBeTruthy() // B has no picture
    expect(screen.queryByAltText('A')).toBeNull()
  })

  it('record_detail with a related table: picker shows the picked row fields and moves the carousel to its picture', async () => {
    const product = { id: '7', name: 'Chair', picture: true }
    const variants = [{ id: 'v1', product_id: '7', name: 'Red', unit_price: 10, picture: true }, { id: 'v2', product_id: '7', name: 'Blue', unit_price: 12, picture: true }]
    const s: PublicDataSource = {
      get: async () => product,
      list: async (table, q) => (table === 'product_variant' && q.filter?.product_id === '7' ? { records: variants, total: 2 } : null),
    }
    await renderBlock(block('record_detail', { table: 'product', fields: ['name'], title_field: 'name', picture_field: 'picture',
      related: { table: 'product_variant', link_field: 'product_id', fields: ['unit_price'], title_field: 'name', picture_field: 'picture' } }), s, { id: '7' })
    expect(screen.getByText('Unit price: 10')).toBeTruthy() // first variant picked by default
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }))
    expect(screen.getByText('Unit price: 12')).toBeTruthy()
    expect(screen.getByRole('img').getAttribute('src')).toBe('/api/v1/public/product_variant/v2/picture/picture')
  })

  it('record_detail reads the id from the URL; unknown id renders nothing', async () => {
    const s = source([{ id: '7', name: 'Lamp' }])
    await renderBlock(block('record_detail', { table: 'product', fields: ['name'], title_field: 'name' }), s, { id: '7' })
    expect(screen.getByRole('heading', { name: 'Lamp' })).toBeTruthy()
    const { container } = await renderBlock(block('record_detail', { table: 'product', fields: ['name'], title_field: 'name' }), s, { id: '8' })
    expect(container.textContent).not.toContain('8')
  })

  it('booking blocks render nothing for a missing, unpublished or wrong-kind event', async () => {
    let { container } = await renderBlock(block('event_booking', {}), source([]))
    expect(container.textContent).toBe('')
    ;({ container } = await renderBlock(block('appointment_booking', { event_id: 'e1' }), source([{ id: 'e1', kind: 'sessions' }])))
    expect(container.textContent).toBe('')
  })
})

describe('stackOrder', () => {
  it('orders by row then column', () => {
    const b = (id: string, x: number, y: number): Block => ({ id, type: 'text', x, y, w: 6, h: 1, config: {} })
    expect(stackOrder([b('c', 0, 2), b('b', 6, 0), b('a', 0, 0)]).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })
})
