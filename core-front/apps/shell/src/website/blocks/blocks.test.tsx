import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
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

  it('record_list on an unpublished table renders nothing', async () => {
    const { container } = await renderBlock(block('record_list', { table: 'crm', fields: ['name'], title_field: 'name' }), source(null))
    expect(container.textContent).toBe('')
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
