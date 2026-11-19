import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { PublishedTable } from '@/lib/website-settings'
import { SearchSettings, targetFields } from './SearchSettings'

const tables = [
  { table: 'product', declared: ['name', 'description', 'picture'], fields: ['name'], pictures: ['picture'] },
  { table: 'event', declared: ['title', 'location'], fields: [], pictures: [] },
] as unknown as PublishedTable[]

describe('SearchSettings', () => {
  it('adds a table with its name-like title field, then the next free table', () => {
    const onChange = vi.fn()
    const { rerender } = render(<SearchSettings blockId="b" config={{ targets: [] }} tables={tables} pages={[]} onChange={onChange} renderPublish={() => null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add table' }))
    expect(onChange).toHaveBeenLastCalledWith({ targets: [{ table: 'product', title_field: 'name', search_fields: [] }] })
    rerender(<SearchSettings blockId="b" config={{ targets: [{ table: 'product', title_field: 'name' }] }} tables={tables} pages={[]} onChange={onChange} renderPublish={() => null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add table' }))
    expect(onChange).toHaveBeenLastCalledWith({ targets: [{ table: 'product', title_field: 'name' }, { table: 'event', title_field: 'title', search_fields: [] }] })
  })

  it('ticks the title field by default and adds searched columns to it', () => {
    const onChange = vi.fn()
    render(<SearchSettings blockId="b" config={{ targets: [{ table: 'product', title_field: 'name' }] }} tables={tables} pages={[]} onChange={onChange} renderPublish={() => null} />)
    const group = screen.getByRole('group', { name: 'Search in' })
    expect(within(group).getByRole('checkbox', { name: 'name' })).toBeChecked()
    fireEvent.click(within(group).getByRole('checkbox', { name: 'description' }))
    expect(onChange).toHaveBeenLastCalledWith({ targets: [{ table: 'product', title_field: 'name', search_fields: ['name', 'description'] }] })
  })

  it('removes a table and asks to publish the columns it reads', () => {
    const onChange = vi.fn()
    const renderPublish = vi.fn(() => null)
    render(<SearchSettings blockId="b" config={{ targets: [{ table: 'product', title_field: 'name', search_fields: ['description'], picture_field: 'picture' }] }}
      tables={tables} pages={[]} onChange={onChange} renderPublish={renderPublish} />)
    expect(renderPublish).toHaveBeenCalledWith(tables[0], ['name', 'description', 'picture'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove table' }))
    expect(onChange).toHaveBeenLastCalledWith({ targets: [] })
  })

  it('targetFields lists each column once', () => {
    expect(targetFields({ table: 't', title_field: 'name', search_fields: ['name'] })).toEqual(['name'])
  })
})
