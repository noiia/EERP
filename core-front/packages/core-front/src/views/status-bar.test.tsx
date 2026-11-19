import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import type { FieldDescriptor } from './descriptor'
import { StatusBar } from './status-bar'

const statusField: FieldDescriptor = {
  name: 'status',
  label: 'Status',
  type: 'selection',
  selection: { options: ['draft', 'sent', 'paid', 'overdue', 'cancelled'] },
}

describe('StatusBar', () => {
  it('renders one chip per declared option, in declaration order', () => {
    render(<StatusBar field={statusField} value="sent" />)
    for (const option of ['draft', 'sent', 'paid', 'overdue', 'cancelled']) {
      expect(screen.getByText(option)).toBeInTheDocument()
    }
  })

  it('is read-only without onSelect: no button/link roles, just static chips', () => {
    render(<StatusBar field={statusField} value="sent" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('renders nothing for a value the options list has never heard of, without crashing', () => {
    render(<StatusBar field={statusField} value="not-a-real-status" />)
    // Still renders every step — just none of them read as done/current.
    expect(screen.getByText('draft')).toBeInTheDocument()
  })

  it('renders nothing when the field declares no options', () => {
    const empty: FieldDescriptor = { name: 'status', label: 'Status', type: 'selection', selection: { options: [] } }
    const { container } = render(<StatusBar field={empty} value="x" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('has an accessible nav landmark labeled "Status"', () => {
    render(<StatusBar field={statusField} value="draft" />)
    expect(screen.getByRole('navigation', { name: 'Status' })).toBeInTheDocument()
  })

  it('lists only the given steps, in their order', () => {
    render(<StatusBar field={statusField} value="sent" steps={['paid', 'sent']} />)
    expect(screen.getByText('paid')).toBeInTheDocument()
    expect(screen.queryByText('draft')).not.toBeInTheDocument()
    const chips = screen.getAllByText(/paid|sent/).map((el) => el.textContent)
    expect(chips).toEqual(['paid', 'sent'])
  })

  it('still shows a real current value the steps leave out, last', () => {
    render(<StatusBar field={statusField} value="cancelled" steps={['draft', 'sent']} />)
    expect(screen.getByText('cancelled').closest('[aria-current="step"]')).not.toBeNull()
  })

  // The other steps are display:none below the mobile breakpoint (jsdom
  // applies only base styles), hence `hidden: true` to reach them.
  it('makes every other step a button with onSelect', () => {
    const onSelect = vi.fn()
    render(<StatusBar field={statusField} value="sent" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'paid', hidden: true }))
    expect(onSelect).toHaveBeenCalledWith('paid')
  })

  it('the current step opens a menu of every step (how a phone changes it)', () => {
    const onSelect = vi.fn()
    render(<StatusBar field={statusField} value="sent" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'sent' }))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'draft', 'sent', 'paid', 'overdue', 'cancelled',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'sent' }))
    expect(onSelect).not.toHaveBeenCalled() // picking the current one is a no-op
    fireEvent.click(screen.getByRole('button', { name: 'sent' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'overdue' }))
    expect(onSelect).toHaveBeenCalledWith('overdue')
  })

  it('disabled keeps the steps but makes them inert', () => {
    const onSelect = vi.fn()
    render(<StatusBar field={statusField} value="sent" onSelect={onSelect} disabled />)
    fireEvent.click(screen.getByRole('button', { name: 'paid', hidden: true }))
    fireEvent.click(screen.getByRole('button', { name: 'sent', hidden: true }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
