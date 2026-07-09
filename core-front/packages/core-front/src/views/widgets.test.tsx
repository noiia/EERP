import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { FieldDescriptor } from './descriptor'
import { DEFAULT_NUMBER_FORMAT, useFormatStore } from './format-store'
import { fieldWidget, type WidgetProps } from './widgets'

// Each widget is exercised through the same dispatch the form renderer uses:
// fieldWidget(field) -> component; value in, onChange out (a store round-trip
// in miniature — the form store itself is covered by renderers/stores tests).

function renderWidget(field: FieldDescriptor, value: unknown) {
  const onChange = vi.fn()
  const Widget = fieldWidget(field)
  const props: WidgetProps = { field, value, onChange }
  const view = render(<Widget {...props} />)
  return { onChange, view }
}

beforeEach(() => {
  useFormatStore.setState({ ...DEFAULT_NUMBER_FORMAT })
})

describe('text widgets', () => {
  it('simple: renders the value and emits edits', () => {
    const { onChange } = renderWidget({ name: 'name', label: 'Name', type: 'text' }, 'Ada')
    const input = screen.getByLabelText('Name')
    expect(input).toHaveValue('Ada')
    fireEvent.change(input, { target: { value: 'Grace' } })
    expect(onChange).toHaveBeenCalledWith('Grace')
  })

  it('long: renders a multiline textarea', () => {
    renderWidget({ name: 'notes', label: 'Notes', type: 'text', widget: 'long' }, 'line')
    const input = screen.getByLabelText('Notes')
    expect(input.tagName).toBe('TEXTAREA')
  })
})

describe('boolean/switch', () => {
  it('round-trips a toggle', () => {
    const { onChange } = renderWidget({ name: 'ok', label: 'Ok', type: 'boolean' }, false)
    fireEvent.click(screen.getByRole('switch', { name: 'Ok' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('number/float', () => {
  it('formats with the default separators and .2f', () => {
    renderWidget({ name: 'price', label: 'Price', type: 'number' }, 1234567.5)
    expect(screen.getByLabelText('Price')).toHaveValue('1,234,567.50')
  })

  it('reformats when the workspace separators change (no widget code change)', () => {
    useFormatStore.getState().setNumberFormat({ decimalSeparator: ',', thousandsSeparator: ' ' })
    renderWidget({ name: 'price', label: 'Price', type: 'number' }, 1234567.5)
    expect(screen.getByLabelText('Price')).toHaveValue('1 234 567,50')
  })

  it('honors widgetOptions.decimals', () => {
    renderWidget(
      { name: 'price', label: 'Price', type: 'number', widgetOptions: { decimals: 0 } },
      12.7,
    )
    expect(screen.getByLabelText('Price')).toHaveValue('13')
  })

  it('shows the raw value on focus and commits parseable edits', () => {
    const { onChange } = renderWidget({ name: 'price', label: 'Price', type: 'number' }, 1200.5)
    const input = screen.getByLabelText('Price')
    fireEvent.focus(input)
    expect(input).toHaveValue('1200.5')
    fireEvent.change(input, { target: { value: '2500.75' } })
    expect(onChange).toHaveBeenCalledWith(2500.75)
  })

  it('parses with the active decimal separator', () => {
    useFormatStore.getState().setNumberFormat({ decimalSeparator: ',', thousandsSeparator: ' ' })
    const { onChange } = renderWidget({ name: 'price', label: 'Price', type: 'number' }, null)
    const input = screen.getByLabelText('Price')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '12,5' } })
    expect(onChange).toHaveBeenCalledWith(12.5)
  })

  it('clears to null on empty input', () => {
    const { onChange } = renderWidget({ name: 'price', label: 'Price', type: 'number' }, 4)
    const input = screen.getByLabelText('Price')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith(null)
  })
})

describe('number/int', () => {
  it('formats without decimals and rounds edits to integers', () => {
    const { onChange } = renderWidget(
      { name: 'qty', label: 'Qty', type: 'number', widget: 'int' },
      1000,
    )
    const input = screen.getByLabelText('Qty')
    expect(input).toHaveValue('1,000')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '3.7' } })
    expect(onChange).toHaveBeenCalledWith(4)
  })
})

describe('number/percent', () => {
  it('displays a ratio ×100 with a % adornment and stores edits ÷100', () => {
    const { onChange } = renderWidget(
      { name: 'rate', label: 'Rate', type: 'number', widget: 'percent' },
      0.25,
    )
    const input = screen.getByLabelText('Rate')
    expect(input).toHaveValue('25.00')
    expect(screen.getByText('%')).toBeInTheDocument()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '50' } })
    expect(onChange).toHaveBeenCalledWith(0.5)
  })

  it('base "percent" stores the displayed value as-is', () => {
    const { onChange } = renderWidget(
      { name: 'rate', label: 'Rate', type: 'number', widget: 'percent', widgetOptions: { base: 'percent' } },
      25,
    )
    const input = screen.getByLabelText('Rate')
    expect(input).toHaveValue('25.00')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '60' } })
    expect(onChange).toHaveBeenCalledWith(60)
  })
})

describe('number/stars', () => {
  it('defaults to 3 stars with half-step granularity', () => {
    const { onChange } = renderWidget(
      { name: 'score', label: 'Score', type: 'number', widget: 'stars' },
      1,
    )
    // precision 0.5 over max 3 -> radios at 0.5..3; half steps must exist.
    const half = screen.getByLabelText('1.5 Stars')
    expect(screen.queryByLabelText('4 Stars')).not.toBeInTheDocument()
    fireEvent.click(half)
    expect(onChange).toHaveBeenCalledWith(1.5)
  })

  it('honors widgetOptions.max', () => {
    renderWidget(
      { name: 'score', label: 'Score', type: 'number', widget: 'stars', widgetOptions: { max: 5 } },
      2,
    )
    expect(screen.getByLabelText('5 Stars')).toBeInTheDocument()
  })
})

describe('phone', () => {
  it('splits a stored E.164 value into country indicator + national digits', () => {
    renderWidget({ name: 'phone', label: 'Phone', type: 'text', widget: 'phone' }, '+33612345678')
    expect(screen.getByText('🇫🇷 +33')).toBeInTheDocument()
    expect(screen.getByLabelText('Phone')).toHaveValue('612345678')
  })

  it('normalizes text edits to E.164 with the selected dial code', () => {
    const { onChange } = renderWidget(
      { name: 'phone', label: 'Phone', type: 'text', widget: 'phone' },
      '+33612345678',
    )
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '699 88 77 66' } })
    expect(onChange).toHaveBeenCalledWith('+33699887766')
  })

  it('stores digits (no plus) on a number field', () => {
    const { onChange } = renderWidget(
      { name: 'phone', label: 'Phone', type: 'number', widget: 'phone' },
      33612345678,
    )
    expect(screen.getByLabelText('Phone')).toHaveValue('612345678')
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '700000001' } })
    expect(onChange).toHaveBeenCalledWith(33700000001)
  })

  it('clears to null when the national number empties', () => {
    const { onChange } = renderWidget(
      { name: 'phone', label: 'Phone', type: 'text', widget: 'phone' },
      '+33612345678',
    )
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith(null)
  })
})

describe('selection', () => {
  const statusField: FieldDescriptor = {
    name: 'status',
    label: 'Status',
    type: 'selection',
    selection: { options: ['incoming', 'running', 'won', 'lost', 'closed'] },
  }

  it('shows the current value and offers every declared option', () => {
    renderWidget(statusField, 'running')
    const select = screen.getByLabelText('Status')
    expect(select).toHaveTextContent('running')
    fireEvent.mouseDown(select)
    for (const option of ['incoming', 'running', 'won', 'lost', 'closed']) {
      expect(screen.getByRole('option', { name: option })).toBeInTheDocument()
    }
  })

  it('picking an option emits its raw (untranslated) value', () => {
    const { onChange } = renderWidget(statusField, 'incoming')
    fireEvent.mouseDown(screen.getByLabelText('Status'))
    fireEvent.click(screen.getByRole('option', { name: 'won' }))
    expect(onChange).toHaveBeenCalledWith('won')
  })
})

describe('date', () => {
  it('date renders a date input and emits ISO strings', () => {
    const { onChange } = renderWidget({ name: 'due', label: 'Due', type: 'date' }, '2026-07-07')
    const input = screen.getByLabelText('Due')
    expect(input).toHaveAttribute('type', 'date')
    fireEvent.change(input, { target: { value: '2026-08-01' } })
    expect(onChange).toHaveBeenCalledWith('2026-08-01')
  })

  it('strips a full RFC3339 timestamp (a real Go time.Time column) down to a bare date', () => {
    // A native date input's value MUST be exactly 'YYYY-MM-DD' or the browser
    // silently renders it blank — a Go time.Time column round-trips as
    // "2026-07-07T00:00:00Z", not a bare date (the exact bug this guards).
    renderWidget({ name: 'due', label: 'Due', type: 'date' }, '2026-07-07T00:00:00Z')
    const input = screen.getByLabelText('Due') as HTMLInputElement
    expect(input.value).toBe('2026-07-07')
  })
})

// Relation widgets (search/tags/list) are covered in relation-widgets.test.tsx —
// they need the relation block + RelationOps, not the bare-field harness here.
