import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { byPrefixAndName } from '@eerp/core-front'
import { BLOCK_TYPES } from '@/website/types'

import { BLOCK_ICONS, BlockPalette, blockCaption, ungroupedBlockTypes } from './BlockPalette'

describe('BlockPalette', () => {
  it('gives every block type an icon that the shared icon lookup resolves', () => {
    for (const type of BLOCK_TYPES) {
      const name = BLOCK_ICONS[type]
      expect(name, type).toBeTruthy()
      expect(byPrefixAndName.fas[name], `${type} -> ${name}`).toBeDefined()
    }
  })

  it('renders one icon per block type in the Add block menu', () => {
    render(<BlockPalette onAdd={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /add block/i }))
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(BLOCK_TYPES.length)
    for (const item of items) {
      expect(item.querySelector('svg'), item.textContent ?? '').not.toBeNull()
    }
  })

  it('puts every block type in a palette group', () => {
    expect(ungroupedBlockTypes()).toEqual([])
  })

  it('captions a block by its own text, else its table', () => {
    expect(blockCaption({ id: 'a', type: 'hero', x: 0, y: 0, w: 1, h: 1, config: { title: '  Welcome ' } })).toBe('Welcome')
    expect(blockCaption({ id: 'b', type: 'record_list', x: 0, y: 0, w: 1, h: 1, config: { table: 'product' } })).toBe('product')
    expect(blockCaption({ id: 'c', type: 'text', x: 0, y: 0, w: 1, h: 1, config: {} })).toBe('')
  })
})
