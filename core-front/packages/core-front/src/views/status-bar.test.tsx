import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
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

  it('is read-only: no button/link roles, just static chips', () => {
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
})
