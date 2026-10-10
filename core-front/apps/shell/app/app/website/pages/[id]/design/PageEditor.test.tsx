import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

const phone = vi.hoisted(() => ({ value: false }))
vi.mock('@mui/material/useMediaQuery', () => ({ default: () => phone.value }))
vi.mock('@/website/editor-actions', () => ({ previewBlock: async () => null, listEditorEvents: async () => [],
  listEditorPages: async () => [{ slug: 'product', title: 'Product', published: true }] }))
const savePublished = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })))
vi.mock('@/lib/website-settings', () => ({ savePublished }))

import { PageEditor } from './PageEditor'
import type { Block } from '@/website/types'

const published = [
  { table: 'product', declared: ['name', 'unit_price', 'reference', 'picture'], fields: ['name', 'unit_price'], filter: {}, pictures: ['picture'] },
  { table: 'company', declared: ['name'], fields: [], filter: {} },
]
const layout: Block[] = [
  { id: 'b-2', type: 'text', x: 0, y: 4, w: 12, h: 2, config: { body: 'second' } },
  { id: 'b-1', type: 'record_list', x: 0, y: 0, w: 12, h: 4, config: { table: '', fields: [], title_field: '' } },
]

function setup(result: string | null = null) {
  const save = vi.fn(async () => result)
  render(<PageEditor pageId="p1" slug="home" title="Home" layout={layout} published={published} save={save} />)
  return save
}

describe('PageEditor', () => {
  it('adds a block from the palette', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /add block/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /text/i }))
    expect(screen.getAllByTestId(/^editor-block-/)).toHaveLength(3)
  })

  it('record_list settings offer every declared table and its declared fields', () => {
    setup()
    fireEvent.click(screen.getByTestId('editor-block-b-1'))
    const panel = screen.getByTestId('block-settings')
    fireEvent.mouseDown(within(panel).getByLabelText(/table/i))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['product', 'company'])
    fireEvent.click(screen.getByRole('option', { name: 'product' }))
    expect(within(panel).getByRole('checkbox', { name: 'reference' })).toBeTruthy() // declared, not yet published
    fireEvent.mouseDown(within(panel).getByLabelText(/picture field/i))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'picture']) // not name/unit_price
  })

  it('detail page picker lists pages and keeps a slug matching none, flagged', async () => {
    const save = vi.fn(async () => null)
    const dangling: Block = { id: 'b-1', type: 'record_list', x: 0, y: 0, w: 36, h: 18, config: { table: '', fields: [], title_field: '', detail_slug: 'test-details' } }
    render(<PageEditor pageId="p1" slug="home" title="Home" layout={[dangling]} published={published} save={save} />)
    fireEvent.click(screen.getByTestId('editor-block-b-1'))
    const panel = screen.getByTestId('block-settings')
    await screen.findByText(/test-details — page not found/i)
    fireEvent.mouseDown(within(panel).getByLabelText(/detail page/i))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'Product (/product)', 'test-details — page not found'])
  })

  it('flags an unpublished field and publishes it on click, keeping the published ones', async () => {
    setup()
    fireEvent.click(screen.getByTestId('editor-block-b-1'))
    const panel = screen.getByTestId('block-settings')
    fireEvent.mouseDown(within(panel).getByLabelText(/table/i))
    fireEvent.click(screen.getByRole('option', { name: 'product' }))
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'name' }))
    expect(within(panel).queryByText(/not public yet/i)).toBeNull()
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'reference' }))
    expect(within(panel).getByText(/not public yet/i).textContent).toContain('reference')
    fireEvent.click(within(panel).getByRole('button', { name: 'Publish' }))
    await vi.waitFor(() => expect(within(panel).queryByText(/not public yet/i)).toBeNull())
    expect(savePublished).toHaveBeenCalledWith('product', { fields: ['name', 'unit_price', 'reference'], filter: {} })
  })

  it('event_list: checking "nearest" tells where to publish the map position', () => {
    const list: Block = { id: 'b-1', type: 'event_list', x: 0, y: 0, w: 36, h: 18, config: {} }
    render(<PageEditor pageId="p1" slug="home" title="Home" layout={[list]} published={published} save={vi.fn(async () => null)} />)
    fireEvent.click(screen.getByTestId('editor-block-b-1'))
    const panel = screen.getByTestId('block-settings')
    expect(within(panel).queryByText(/geo_location/)).toBeNull()
    fireEvent.click(within(panel).getByRole('checkbox', { name: /nearest to me/i }))
    expect(within(panel).getByText(/geo_location/).textContent).toContain('Published data')
  })

  it('saves the current layout', async () => {
    const save = setup()
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'b-1' })])))
  })

  it('translates the generic save failure (the action returns an empty message)', async () => {
    setup('')
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('Could not save.')).toBeTruthy()
  })

  it('stacks blocks in (y, x) order on phones (Review Focus #5)', () => {
    phone.value = true
    setup()
    expect(screen.getAllByTestId(/^editor-block-/).map((e) => e.dataset.testid)).toEqual(['editor-block-b-1', 'editor-block-b-2'])
    phone.value = false
  })
})
