import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

const phone = vi.hoisted(() => ({ value: false }))
vi.mock('@mui/material/useMediaQuery', () => ({ default: () => phone.value }))
vi.mock('@/website/editor-actions', () => ({ previewBlock: async () => null }))

import { PageEditor } from './PageEditor'
import type { Block } from '@/website/types'

const published = [
  { table: 'product', declared: ['name', 'unit_price', 'reference'], fields: ['name', 'unit_price'], filter: {} },
  { table: 'company', declared: ['name'], fields: [], filter: {} },
]
const layout: Block[] = [
  { id: 'b-2', type: 'text', x: 0, y: 4, w: 12, h: 2, config: { body: 'second' } },
  { id: 'b-1', type: 'record_list', x: 0, y: 0, w: 12, h: 4, config: { table: '', fields: [], title_field: '' } },
]

function setup() {
  const save = vi.fn(async () => null)
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

  it('record_list settings offer only published tables and published fields', () => {
    setup()
    fireEvent.click(screen.getByTestId('editor-block-b-1'))
    const panel = screen.getByTestId('block-settings')
    fireEvent.mouseDown(within(panel).getByLabelText(/table/i))
    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['product']) // company publishes no field
    fireEvent.click(screen.getByRole('option', { name: 'product' }))
    expect(within(panel).getByRole('checkbox', { name: 'name' })).toBeTruthy()
    expect(within(panel).queryByRole('checkbox', { name: 'reference' })).toBeNull() // declared, not published
  })

  it('saves the current layout', async () => {
    const save = setup()
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'b-1' })])))
  })

  it('stacks blocks in (y, x) order on phones (Review Focus #5)', () => {
    phone.value = true
    setup()
    expect(screen.getAllByTestId(/^editor-block-/).map((e) => e.dataset.testid)).toEqual(['editor-block-b-1', 'editor-block-b-2'])
    phone.value = false
  })
})
