import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const listEditorRecords = vi.hoisted(() => vi.fn())
vi.mock('@/website/editor-actions', () => ({ listEditorRecords }))

import { RecordPicker } from './RecordPicker'

beforeEach(() => {
  listEditorRecords.mockReset().mockImplementation(async (_t: string, _l: string, q: { search?: string; ids?: string[] }) =>
    q.ids ? q.ids.map((id) => ({ id, label: `Known ${id}` })) : [{ id: 'r1', label: 'Chair' }, { id: 'r2', label: 'Table' }])
})

describe('RecordPicker', () => {
  it('labels already-picked rows and searches as the user types', async () => {
    const onChange = vi.fn()
    render(<RecordPicker table="product" labelField="name" value={['r9']} onChange={onChange} label="Record" />)
    await waitFor(() => expect(screen.getByDisplayValue('Known r9')).toBeTruthy())
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'ch' } })
    await waitFor(() => expect(listEditorRecords).toHaveBeenCalledWith('product', 'name', { search: 'ch' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Chair' }))
    expect(onChange).toHaveBeenLastCalledWith(['r1'])
  })

  it('clears a single pick', async () => {
    const onChange = vi.fn()
    render(<RecordPicker table="product" labelField="name" value={['r1']} onChange={onChange} label="Record" />)
    await screen.findByDisplayValue('Known r1')
    fireEvent.click(screen.getByLabelText('Clear'))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('keeps the picked order in multiple mode', async () => {
    const onChange = vi.fn()
    render(<RecordPicker table="product" labelField="name" value={['r2']} onChange={onChange} multiple label="Records" />)
    await screen.findByText('Known r2')
    fireEvent.mouseDown(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: 'Chair' }))
    expect(onChange).toHaveBeenLastCalledWith(['r2', 'r1'])
  })
})
