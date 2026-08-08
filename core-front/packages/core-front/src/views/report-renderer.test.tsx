import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReportRenderer } from './report-renderer'
import type { ReportDescriptor } from './report-descriptor'

const baseDescriptor: ReportDescriptor = {
  name: 'crm.statement',
  entity: 'crm',
  permissions: ['crm:crm:read'],
  layout: [],
}

describe('ReportRenderer', () => {
  it('renders a field node\'s raw value', () => {
    const descriptor: ReportDescriptor = {
      ...baseDescriptor,
      layout: [{ kind: 'field', name: 'name' }],
    }
    render(<ReportRenderer descriptor={descriptor} record={{ name: 'Acme Corp' }} />)
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
  })

  it('renders an empty string for a null/undefined field value', () => {
    const descriptor: ReportDescriptor = {
      ...baseDescriptor,
      layout: [{ kind: 'field', name: 'missing', className: 'field-missing' }],
    }
    const { container } = render(<ReportRenderer descriptor={descriptor} record={{}} />)
    expect(container.querySelector('.field-missing')?.textContent).toBe('')
  })

  it('formats a number field through formatNumber (grouped, default separators)', () => {
    const descriptor: ReportDescriptor = {
      ...baseDescriptor,
      layout: [{ kind: 'field', name: 'total', format: 'number' }],
    }
    render(<ReportRenderer descriptor={descriptor} record={{ total: 1234.5 }} />)
    expect(screen.getByText('1,234.5')).toBeInTheDocument()
  })

  it('formats a date field as a localized date, not the raw ISO string', () => {
    const descriptor: ReportDescriptor = {
      ...baseDescriptor,
      layout: [{ kind: 'field', name: 'created_at', format: 'date', className: 'created-at' }],
    }
    const { container } = render(
      <ReportRenderer descriptor={descriptor} record={{ created_at: '2026-01-15T00:00:00Z' }} />,
    )
    const text = container.querySelector('.created-at')?.textContent ?? ''
    expect(text).not.toBe('2026-01-15T00:00:00Z')
    expect(text.length).toBeGreaterThan(0)
  })

  it('leaves an unparseable date value untouched', () => {
    const descriptor: ReportDescriptor = {
      ...baseDescriptor,
      layout: [{ kind: 'field', name: 'created_at', format: 'date' }],
    }
    render(<ReportRenderer descriptor={descriptor} record={{ created_at: 'not-a-date' }} />)
    expect(screen.getByText('not-a-date')).toBeInTheDocument()
  })

  it('renders a section, applying its className and walking its children', () => {
    const descriptor: ReportDescriptor = {
      ...baseDescriptor,
      layout: [
        {
          kind: 'section',
          className: 'header-block',
          children: [
            { kind: 'field', name: 'name' },
            { kind: 'field', name: 'email' },
          ],
        },
      ],
    }
    const { container } = render(
      <ReportRenderer descriptor={descriptor} record={{ name: 'Acme', email: 'a@acme.test' }} />,
    )
    const section = container.querySelector('.header-block')
    expect(section).not.toBeNull()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('a@acme.test')).toBeInTheDocument()
  })

  it('renders a table node from an array-valued field, columns in order', () => {
    const descriptor: ReportDescriptor = {
      ...baseDescriptor,
      layout: [
        {
          kind: 'table',
          source: 'line_items',
          columns: [
            { name: 'description', label: 'Description' },
            { name: 'total', label: 'Total' },
          ],
        },
      ],
    }
    render(
      <ReportRenderer
        descriptor={descriptor}
        record={{
          line_items: [
            { description: 'Consulting', total: 100 },
            { description: 'Hosting', total: 50 },
          ],
        }}
      />,
    )
    expect(screen.getByText('Description')).toBeInTheDocument()
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('Consulting')).toBeInTheDocument()
    expect(screen.getByText('Hosting')).toBeInTheDocument()
  })

  it('renders a table with a header row and no body rows when the source is absent', () => {
    const descriptor: ReportDescriptor = {
      ...baseDescriptor,
      layout: [
        {
          kind: 'table',
          source: 'line_items',
          columns: [{ name: 'description', label: 'Description' }],
        },
      ],
    }
    const { container } = render(<ReportRenderer descriptor={descriptor} record={{}} />)
    expect(screen.getByText('Description')).toBeInTheDocument()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0)
  })

  it('renders a pageBreak node with the print-target hook class', () => {
    const descriptor: ReportDescriptor = { ...baseDescriptor, layout: [{ kind: 'pageBreak' }] }
    const { container } = render(<ReportRenderer descriptor={descriptor} record={{}} />)
    expect(container.querySelector('.eerp-page-break')).not.toBeNull()
  })
})
