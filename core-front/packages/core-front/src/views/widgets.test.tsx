import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { FieldDescriptor } from './descriptor'
import { useCompanyStore } from './company-store'
import { DEFAULT_NUMBER_FORMAT, useFormatStore } from './format-store'
import { fieldWidget, type WidgetProps } from './widgets'

// Each widget is exercised through the same dispatch the form renderer uses:
// fieldWidget(field) -> component; value in, onChange out (a store round-trip
// in miniature — the form store itself is covered by renderers/stores tests).

function renderWidget(field: FieldDescriptor, value: unknown, extra?: Partial<WidgetProps>) {
  const onChange = vi.fn()
  const onChangeField = vi.fn()
  const Widget = fieldWidget(field)
  const props: WidgetProps = { field, value, onChange, onChangeField, ...extra }
  const view = render(<Widget {...props} />)
  return { onChange, onChangeField, view }
}

beforeEach(() => {
  useFormatStore.setState({ ...DEFAULT_NUMBER_FORMAT })
  useCompanyStore.setState({ currency: '' })
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

describe('text/color', () => {
  const colorField: FieldDescriptor = { name: 'accent', label: 'Accent', type: 'text', widget: 'color' }

  it('renders the swatch and hex field seeded from the value', () => {
    renderWidget(colorField, '#f2f2f2')
    expect(screen.getByLabelText('Accent')).toHaveValue('#f2f2f2')
    expect(screen.getByLabelText('Accent swatch')).toHaveValue('#f2f2f2')
  })

  it('typing in the hex field emits the raw typed value', () => {
    const { onChange } = renderWidget(colorField, '#f2f2f2')
    fireEvent.change(screen.getByLabelText('Accent'), { target: { value: '#123456' } })
    expect(onChange).toHaveBeenCalledWith('#123456')
  })

  it('flags an invalid hex value', () => {
    renderWidget(colorField, 'nope')
    expect(screen.getByLabelText('Accent')).toHaveValue('nope')
    expect(screen.getByText(/enter a hex color/i)).toBeInTheDocument()
  })

  it('still emits whatever is typed even while invalid, so a mid-edit value is never discarded', () => {
    const { onChange } = renderWidget(colorField, 'nope')
    fireEvent.change(screen.getByLabelText('Accent'), { target: { value: 'nope2' } })
    expect(onChange).toHaveBeenCalledWith('nope2')
  })

  it('shows no error on an empty (unset) value', () => {
    renderWidget(colorField, '')
    expect(screen.queryByText(/enter a hex color/i)).not.toBeInTheDocument()
  })

  it('picking a color via the swatch emits its hex value', () => {
    const { onChange } = renderWidget(colorField, '#f2f2f2')
    fireEvent.change(screen.getByLabelText('Accent swatch'), { target: { value: '#00ff00' } })
    expect(onChange).toHaveBeenCalledWith('#00ff00')
  })
})

describe('text/url', () => {
  const urlField: FieldDescriptor = { name: 'website', label: 'Website', type: 'text', widget: 'url' }

  it('renders the value and emits edits like a plain text field', () => {
    const { onChange } = renderWidget(urlField, 'https://example.com')
    const input = screen.getByLabelText('Website')
    expect(input).toHaveValue('https://example.com')
    fireEvent.change(input, { target: { value: 'https://example.org' } })
    expect(onChange).toHaveBeenCalledWith('https://example.org')
  })

  it('disables the open button while empty', () => {
    renderWidget(urlField, '')
    expect(screen.getByRole('button', { name: 'Open link' })).toBeDisabled()
  })

  it('opens a full-scheme URL as typed', () => {
    const openMock = vi.fn()
    vi.stubGlobal('open', openMock)
    renderWidget(urlField, 'https://example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Open link' }))
    expect(openMock).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    vi.unstubAllGlobals()
  })

  it('adds https:// when opening a schemeless value, without rewriting the stored value', () => {
    const openMock = vi.fn()
    vi.stubGlobal('open', openMock)
    const { onChange } = renderWidget(urlField, 'example.com')
    expect(screen.getByLabelText('Website')).toHaveValue('example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Open link' }))
    expect(openMock).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    expect(onChange).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
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

describe('number/monetary', () => {
  it('formats like number/float with no adornment while the company currency is unresolved', () => {
    renderWidget({ name: 'price', label: 'Price', type: 'number', widget: 'monetary' }, 1200.5)
    expect(screen.getByLabelText('Price')).toHaveValue('1,200.50')
    expect(screen.queryByText('USD')).not.toBeInTheDocument()
  })

  it('decorates with the active company currency code once useCompanyStore resolves one', () => {
    useCompanyStore.setState({ currency: 'USD' })
    renderWidget({ name: 'price', label: 'Price', type: 'number', widget: 'monetary' }, 1200.5)
    expect(screen.getByLabelText('Price')).toHaveValue('1,200.50')
    expect(screen.getByText('USD')).toBeInTheDocument()
  })

  it('edits round-trip exactly like number/float', () => {
    useCompanyStore.setState({ currency: 'EUR' })
    const { onChange } = renderWidget(
      { name: 'price', label: 'Price', type: 'number', widget: 'monetary' },
      null,
    )
    const input = screen.getByLabelText('Price')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '99.9' } })
    expect(onChange).toHaveBeenCalledWith(99.9)
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

describe('selection/linked', () => {
  const presetField: FieldDescriptor = {
    name: 'size_preset',
    label: 'Standard size',
    type: 'selection',
    widget: 'linked',
    selection: { options: ['Custom', 'A4', 'Letter'] },
    widgetOptions: {
      presets: {
        A4: { width: 21, height: 29.7, unit: 'cm' },
        Letter: { width: 8.5, height: 11, unit: 'in' },
      },
    },
  }

  it('behaves like a plain select for its own value', () => {
    const { onChange } = renderWidget(presetField, 'Custom')
    fireEvent.mouseDown(screen.getByLabelText('Standard size'))
    fireEvent.click(screen.getByRole('option', { name: 'A4' }))
    expect(onChange).toHaveBeenCalledWith('A4')
  })

  it('picking a preset patches every sibling field it declares', () => {
    const { onChangeField } = renderWidget(presetField, 'Custom')
    fireEvent.mouseDown(screen.getByLabelText('Standard size'))
    fireEvent.click(screen.getByRole('option', { name: 'A4' }))
    expect(onChangeField).toHaveBeenCalledWith('width', 21)
    expect(onChangeField).toHaveBeenCalledWith('height', 29.7)
    expect(onChangeField).toHaveBeenCalledWith('unit', 'cm')
  })

  it('an option with no matching preset (e.g. Custom) patches nothing', () => {
    const { onChangeField } = renderWidget(presetField, 'A4')
    fireEvent.mouseDown(screen.getByLabelText('Standard size'))
    fireEvent.click(screen.getByRole('option', { name: 'Custom' }))
    expect(onChangeField).not.toHaveBeenCalled()
  })

  it('does not throw when onChangeField is absent', () => {
    const onChange = vi.fn()
    const Widget = fieldWidget(presetField)
    render(<Widget field={presetField} value="Custom" onChange={onChange} />)
    fireEvent.mouseDown(screen.getByLabelText('Standard size'))
    expect(() => fireEvent.click(screen.getByRole('option', { name: 'A4' }))).not.toThrow()
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

// text/table (docs/roadmaps/app-store.md, Phase 2): a generic read-only
// array-of-records display, not an editable widget — no onChange assertions
// here, because the widget never calls it.
describe('text/table', () => {
  const tableField: FieldDescriptor = {
    name: 'views',
    label: 'Views',
    type: 'text',
    widget: 'table',
    store: false,
    widgetOptions: {
      columns: [
        { key: 'view', label: 'View' },
        { key: 'file', label: 'File' },
      ],
    },
  }

  it('renders declared columns and one row per array entry, in order', () => {
    renderWidget(tableField, [
      { view: '/crm', file: 'CrmViews.ts' },
      { view: '/crm/:id', file: 'CrmViews.ts' },
    ])
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['View', 'File'])
    const rows = screen.getAllByRole('row').slice(1) // drop the header row
    expect(rows.map((r) => r.textContent)).toEqual(['/crmCrmViews.ts', '/crm/:idCrmViews.ts'])
  })

  it('a row missing a declared column key renders an empty cell, never throws', () => {
    expect(() => renderWidget(tableField, [{ view: '/crm' }])).not.toThrow()
    const cells = screen.getAllByRole('cell')
    expect(cells[0]).toHaveTextContent('/crm')
    expect(cells[1]).toHaveTextContent('')
  })

  it('shows the empty-state caption for an empty array', () => {
    renderWidget(tableField, [])
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('honors a custom widgetOptions.emptyLabel', () => {
    renderWidget({ ...tableField, widgetOptions: { ...tableField.widgetOptions, emptyLabel: 'None yet.' } }, [])
    expect(screen.getByText('None yet.')).toBeInTheDocument()
  })

  it('a non-array value (e.g. undefined before the seed lands) degrades to the empty state', () => {
    renderWidget(tableField, undefined)
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument()
  })
})

describe('hideLabel', () => {
  it('text/simple: suppresses the label but still renders an editable input', () => {
    renderWidget({ name: 'name', label: 'Name', type: 'text', hideLabel: true }, 'Ada')
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('Ada')
  })

  it('boolean/switch: suppresses the label but the switch stays interactive', () => {
    const { onChange } = renderWidget({ name: 'ok', label: 'Ok', type: 'boolean', hideLabel: true }, false)
    expect(screen.queryByText('Ok')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('number/stars: suppresses the caption legend but the rating still renders', () => {
    renderWidget(
      { name: 'score', label: 'Score', type: 'number', widget: 'stars', hideLabel: true },
      1,
    )
    expect(screen.queryByText('Score')).not.toBeInTheDocument()
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(0)
  })

  it('selection: suppresses the label but the dropdown still renders its options', () => {
    renderWidget(
      {
        name: 'status',
        label: 'Status',
        type: 'selection',
        hideLabel: true,
        selection: { options: ['open', 'closed'] },
      },
      'open',
    )
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveTextContent('open')
  })

  it('without hideLabel, the label renders as usual (regression)', () => {
    renderWidget({ name: 'name', label: 'Name', type: 'text' }, 'Ada')
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
  })
})
