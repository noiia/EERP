import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const phoneIcon = { family: 'solid', name: 'phone', width: 512, height: 512, path: 'M0 0h512v512H0z' }
const actions = vi.hoisted(() => ({
  describeFields: vi.fn(async () => ({ phone: { kind: 'phone' }, unit_price: { kind: 'monetary' }, name: { kind: 'text' } })),
  searchFieldIcons: vi.fn(async () => [phoneIcon]),
  previewField: vi.fn(async (_t: string, field: string, display: { custom_label?: string; hide_label?: boolean }) => ({
    column: { name: field, label: display.hide_label ? null : display.custom_label || 'Phone', spoken: display.custom_label || 'Phone', icon: null },
    value: { text: '06 12 34 56 78', href: 'tel:+33612345678' },
    sample: false,
  })),
}))
vi.mock('@/website/field-display-actions', () => actions)

import { FieldDisplayList } from './FieldDisplaySettings'

function setup(displays = {}) {
  const onChange = vi.fn()
  render(<FieldDisplayList table="contact" fields={['phone', 'unit_price', 'name']} columns={['phone', 'unit_price', 'name', 'currency']} displays={displays} onChange={onChange} />)
  return onChange
}
const open = async (field: string) => {
  fireEvent.click(await screen.findByRole('button', { name: `Display settings: ${field}` }))
  return screen.findByRole('dialog')
}

describe('FieldDisplayList', () => {
  it('lists each shown field with its label, kind and customizations', async () => {
    setup({ name: { hide_label: true, icon: { name: 'user' } } })
    const phone = await screen.findByRole('button', { name: 'Display settings: phone' })
    await waitFor(() => expect(within(phone).getAllByText('Phone')).toHaveLength(2)) // label, then its kind
    const name = screen.getByRole('button', { name: 'Display settings: name' })
    expect(within(name).getByText('Label hidden')).toBeTruthy()
    expect(within(name).getByText('Text, with an icon')).toBeTruthy()
  })

  it('adapts the formatting settings to the kind of field', async () => {
    setup()
    let dialog = await open('phone')
    expect(within(dialog).getByLabelText(/country of numbers/i)).toBeTruthy()
    expect(within(dialog).queryByLabelText('Currency')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    dialog = await open('unit_price')
    expect(within(dialog).getByLabelText('Currency')).toBeTruthy()
    expect(within(dialog).queryByLabelText(/country of numbers/i)).toBeNull()
  })

  it('saves the label and an icon picked from the search, and previews them', async () => {
    const onChange = setup()
    const dialog = await open('phone')
    fireEvent.change(within(dialog).getByLabelText('Custom label'), { target: { value: 'Call us' } })
    await waitFor(() => expect(actions.previewField).toHaveBeenLastCalledWith('contact', 'phone', expect.objectContaining({ custom_label: 'Call us' })))
    expect(await within(dialog).findByText('Call us:')).toBeTruthy() // the live preview
    fireEvent.change(within(dialog).getByLabelText('Search icons'), { target: { value: 'pho' } })
    await act(async () => { await new Promise((r) => setTimeout(r, 250)) })
    fireEvent.click(await within(dialog).findByRole('option', { name: 'phone, solid' }))
    expect(within(dialog).getByRole('option', { name: 'phone, solid' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(within(dialog).getByRole('button', { name: 'After the value' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))
    expect(onChange).toHaveBeenCalledWith({
      phone: { custom_label: 'Call us', icon: { name: 'phone', family: 'solid', position: 'after' } },
    })
  })

  it('resets a field to automatic, keeping the others', async () => {
    const onChange = setup({ phone: { hide_label: true }, name: { custom_label: 'Who' } })
    const dialog = await open('phone')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset to automatic' }))
    expect(onChange).toHaveBeenCalledWith({ name: { custom_label: 'Who' } })
  })
})
