import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StackedGrid } from './StackedGrid'
import type { Block } from '../types'

const block = (id: string, type: Block['type'], x: number, y: number, w: number, h: number, config: Record<string, unknown> = {}): Block => ({ id, type, x, y, w, h, config })

const cell = (id: string) => screen.getByText(id).parentElement!

describe('StackedGrid', () => {
  it('places each block on its grid cell, sections first in the DOM', () => {
    const blocks = [
      block('text-a', 'text', 2, 5, 10, 4),
      block('band', 'section', 0, 0, 36, 20, { color: '#000000', title: 'Hello' }),
    ]
    render(<StackedGrid blocks={blocks} render={(b) => <span>{b.id}</span>} />)
    const cells = screen.getAllByText(/text-a|band/).map((e) => e.textContent)
    expect(cells).toEqual(['band', 'text-a'])
  })

  it("gives a block inside a section that section's color for the phone layout, white on a picture", () => {
    const blocks = [
      block('dark', 'section', 0, 0, 18, 10, { color: '#000000' }),
      block('photo', 'section', 18, 0, 18, 10, { table: 'product', field: 'picture' }),
      block('in-dark', 'text', 2, 2, 4, 4),
      block('in-photo', 'text', 20, 2, 4, 4),
      block('alone', 'text', 0, 30, 4, 4),
    ]
    render(<StackedGrid blocks={blocks} render={(b) => <span>{b.id}</span>} />)
    expect(getComputedStyle(cell('in-dark')).color).toBe('rgb(255, 255, 255)')
    expect(getComputedStyle(cell('in-photo')).color).toBe('rgb(255, 255, 255)')
    expect(getComputedStyle(cell('alone')).color).not.toBe('rgb(255, 255, 255)')
  })

  it('a light section gives dark text', () => {
    const blocks = [block('light', 'section', 0, 0, 36, 10, { color: '#ffffff' }), block('inside', 'text', 2, 2, 4, 4)]
    render(<StackedGrid blocks={blocks} render={(b) => <span>{b.id}</span>} />)
    expect(getComputedStyle(cell('inside')).color).toBe('rgba(0, 0, 0, 0.87)')
  })
})
