import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GraphField, GraphFieldDraft } from '../api/graph'
import { CalcFieldDialog, CalcFieldsPanel } from './graph-calc-fields'

const field: GraphField = { id: 'f1', key: 'calc_margin_ab12', label: 'Margin', formula: 'price - cost', roles: ['sales', 'admin'], dated: true }

describe('CalcFieldsPanel', () => {
  it('hides the Variables bloc when the host has no calculated-field support', () => {
    const onAddWidget = vi.fn()
    render(<CalcFieldsPanel fields={[field]} onAddWidget={onAddWidget} onEdit={vi.fn()} onDelete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }))
    expect(onAddWidget).toHaveBeenCalled()
    expect(screen.queryByText('Variables')).toBeNull()
  })

  it('lists the fields: a click edits one, its × deletes it without editing', () => {
    const onAdd = vi.fn()
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    render(<CalcFieldsPanel fields={[field]} onAddWidget={vi.fn()} onAdd={onAdd} onEdit={onEdit} onDelete={onDelete} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
    expect(onAdd).toHaveBeenCalled()
    expect(screen.getByTestId('graph-calc-field-calc_margin_ab12').getAttribute('title')).toBe('price - cost')
    fireEvent.click(screen.getByText('Margin'))
    expect(onEdit).toHaveBeenCalledWith(field)
    fireEvent.click(screen.getByLabelText('Delete field')) // shown on hover only
    expect(onDelete).toHaveBeenCalledWith(field)
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})

describe('CalcFieldDialog', () => {
  it('creates a field: a key from the label, the formula built from the chips, trimmed roles', async () => {
    const onSubmit = vi.fn<(d: GraphFieldDraft) => Promise<string | null>>(async () => null)
    render(<CalcFieldDialog open numberFieldNames={['price', 'cost']} onClose={vi.fn()} onSubmit={onSubmit} />)
    expect(screen.getByText('Add calculated field')).toBeTruthy()
    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(add.disabled).toBe(true) // no label, no formula
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: ' Gross profit! ' } })
    fireEvent.click(screen.getByText('price'))
    fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'price -' } })
    fireEvent.click(screen.getByText('cost'))
    fireEvent.change(screen.getByLabelText(/Roles allowed/), { target: { value: 'sales, , admin ' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(add)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const draft = onSubmit.mock.calls[0]![0]
    expect(draft).toMatchObject({ label: 'Gross profit!', formula: 'price - cost', roles: ['sales', 'admin'], dated: true })
    expect(draft.key).toMatch(/^calc_gross_profit_[a-z0-9]{1,4}$/)
  })

  it('a label with no letters still gets a key', async () => {
    const onSubmit = vi.fn<(d: GraphFieldDraft) => Promise<string | null>>(async () => null)
    render(<CalcFieldDialog open numberFieldNames={[]} onClose={vi.fn()} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '!!!' } })
    fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(onSubmit.mock.calls[0]![0].key).toMatch(/^calc_field_/))
  })

  it('edits a field under its own key, and shows a refusal', async () => {
    const onSubmit = vi.fn<(d: GraphFieldDraft) => Promise<string | null>>(async () => 'Unknown field: cost')
    const onClose = vi.fn()
    render(<CalcFieldDialog open initial={field} numberFieldNames={[]} onClose={onClose} onSubmit={onSubmit} />)
    expect(screen.getByText('Edit calculated field')).toBeTruthy()
    expect((screen.getByLabelText(/Roles allowed/) as HTMLInputElement).value).toBe('sales, admin')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Unknown field: cost')).toBeTruthy()
    expect(onSubmit.mock.calls[0]![0].key).toBe('calc_margin_ab12')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
