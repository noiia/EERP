import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { WidgetConfigDialog } from './graph-widget-config'
import type { ViewDescriptor } from './descriptor'

interface Deal {
  id: string
  name: string
  status?: string | null
  region?: string | null
  amount?: number | null
  closed_at?: string | null
}

const descriptor: ViewDescriptor<Deal> = {
  entity: 'crm',
  viewType: 'tree',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'status', label: 'Status', type: 'selection', selection: { options: ['open', 'won'] } },
    { name: 'region', label: 'Region', type: 'text' },
    { name: 'amount', label: 'Amount', type: 'number' },
    { name: 'closed_at', label: 'Closed', type: 'date' },
  ],
}

async function pickWidgetType(name: string) {
  fireEvent.mouseDown(screen.getByLabelText('Widget type'))
  fireEvent.click(await screen.findByRole('option', { name }))
}

async function pickSelect(label: string, optionName: string) {
  fireEvent.mouseDown(screen.getByLabelText(label))
  fireEvent.click(await screen.findByRole('option', { name: optionName }))
}

function submitButtonName(initial: boolean) {
  return initial ? 'Save' : 'Add'
}

describe('WidgetConfigDialog: stat', () => {
  it('rejects a non-numeric field on mean/median/sum — in the dialog, not at render time', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog
        open
        descriptor={descriptor}
        initial={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    await pickWidgetType('stat')
    await pickSelect('Field', 'Name') // text field
    await pickSelect('Aggregate', 'mean')

    expect(screen.getByText('Mean, median and sum need a number field.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('count works on any field, including non-numeric ones', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog
        open
        descriptor={descriptor}
        initial={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    await pickWidgetType('stat')
    await pickSelect('Field', 'Name')
    // Default aggregate is already 'count'.
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'stat',
      title: '',
      config: { field: 'name', aggregate: 'count' },
    })
  })

  it('accepts mean on a real numeric field', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog
        open
        descriptor={descriptor}
        initial={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    await pickWidgetType('stat')
    await pickSelect('Field', 'Amount')
    await pickSelect('Aggregate', 'mean')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'stat',
      title: '',
      config: { field: 'amount', aggregate: 'mean' },
    })
  })
})

describe('WidgetConfigDialog: xy', () => {
  it('disables Add until both an x (date) and y (number) field are chosen', async () => {
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={vi.fn()} />,
    )
    await pickWidgetType('xy')
    expect(screen.getByText('Pick a date field for X.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await pickSelect('X field (date)', 'Closed')
    expect(screen.getByText('Pick a number field for Y.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await pickSelect('Y field (number)', 'Amount')
    expect(screen.queryByText('Pick a number field for Y.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
  })

  it('produces a valid config with the chosen aggregate and bucket', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={onSubmit} />,
    )
    await pickWidgetType('xy')
    await pickSelect('X field (date)', 'Closed')
    await pickSelect('Y field (number)', 'Amount')
    await pickSelect('Aggregate', 'avg')
    await pickSelect('Bucket', 'week')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'xy',
      title: '',
      config: { xField: 'closed_at', yField: 'amount', aggregate: 'avg', bucket: 'week' },
    })
  })

  it('omits seriesField entirely when left as "None (single line)"', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={onSubmit} />,
    )
    await pickWidgetType('xy')
    await pickSelect('X field (date)', 'Closed')
    await pickSelect('Y field (number)', 'Amount')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const config = onSubmit.mock.calls[0]![0].config
    expect(config).not.toHaveProperty('seriesField')
  })

  it('includes seriesField in the config when a series field is picked', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={onSubmit} />,
    )
    await pickWidgetType('xy')
    await pickSelect('X field (date)', 'Closed')
    await pickSelect('Y field (number)', 'Amount')
    await pickSelect('Series field (optional)', 'Status')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'xy',
      title: '',
      config: { xField: 'closed_at', yField: 'amount', seriesField: 'status', aggregate: 'sum', bucket: 'month' },
    })
  })

  it('re-configuring an xy tile seeds its existing seriesField', async () => {
    render(
      <WidgetConfigDialog
        open
        descriptor={descriptor}
        initial={{
          type: 'xy',
          title: 'Deal flow',
          config: { xField: 'closed_at', yField: 'amount', seriesField: 'status', aggregate: 'sum', bucket: 'month' },
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Series field (optional)')).toHaveTextContent('Status')
  })
})

describe('WidgetConfigDialog: bar', () => {
  it('disables Add until both an x (date) and y (number) field are chosen', async () => {
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={vi.fn()} />,
    )
    await pickWidgetType('bar')
    expect(screen.getByText('Pick a date field for X.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await pickSelect('X field (date)', 'Closed')
    expect(screen.getByText('Pick a number field for Y.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await pickSelect('Y field (number)', 'Amount')
    expect(screen.queryByText('Pick a number field for Y.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
  })

  it('defaults to grouped mode when the mode is left unchanged', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={onSubmit} />,
    )
    await pickWidgetType('bar')
    await pickSelect('X field (date)', 'Closed')
    await pickSelect('Y field (number)', 'Amount')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'bar',
      title: '',
      config: { xField: 'closed_at', yField: 'amount', mode: 'grouped', aggregate: 'sum', bucket: 'month' },
    })
  })

  it('produces a stacked config when "stacked" is picked', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={onSubmit} />,
    )
    await pickWidgetType('bar')
    await pickSelect('X field (date)', 'Closed')
    await pickSelect('Y field (number)', 'Amount')
    await pickSelect('Bar mode', 'stacked')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'bar',
      title: '',
      config: { xField: 'closed_at', yField: 'amount', mode: 'stacked', aggregate: 'sum', bucket: 'month' },
    })
  })

  it('includes seriesField in the config when a series field is picked', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={onSubmit} />,
    )
    await pickWidgetType('bar')
    await pickSelect('X field (date)', 'Closed')
    await pickSelect('Y field (number)', 'Amount')
    await pickSelect('Series field (optional)', 'Status')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'bar',
      title: '',
      config: {
        xField: 'closed_at',
        yField: 'amount',
        seriesField: 'status',
        mode: 'grouped',
        aggregate: 'sum',
        bucket: 'month',
      },
    })
  })

  it('re-configuring a bar tile seeds its existing mode', async () => {
    render(
      <WidgetConfigDialog
        open
        descriptor={descriptor}
        initial={{
          type: 'bar',
          title: 'Deals by month',
          config: { xField: 'closed_at', yField: 'amount', mode: 'stacked', aggregate: 'sum', bucket: 'month' },
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Bar mode')).toHaveTextContent('stacked')
  })
})

describe('WidgetConfigDialog: pie', () => {
  it('produces a config with just groupByField when no value field is picked', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={onSubmit} />,
    )
    await pickWidgetType('pie')
    await pickSelect('Group by field', 'Status')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'pie',
      title: '',
      config: { groupByField: 'status' },
    })
  })

  // No 'aggregate' in either config below: slice SIZE is always record count
  // (docs/roadmaps/list-view-modes.md Phase 5.2) — a value field only adds a
  // displayed sum to the tooltip, so the dialog never needs to ask "sum or
  // count?" for it.
  it('adds valueField (display-only) to the config once one is picked', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={onSubmit} />,
    )
    await pickWidgetType('pie')
    await pickSelect('Group by field', 'Status')
    await pickSelect('Value field (shown in tooltip only)', 'Amount')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'pie',
      title: '',
      config: { groupByField: 'status', valueField: 'amount' },
    })
  })
})

describe('WidgetConfigDialog: list', () => {
  it('requires a filter field, a filter value, and at least one display column', async () => {
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={vi.fn()} />,
    )
    await pickWidgetType('list')
    // displayFields is pre-seeded by orderedFields(), so only field/value are missing.
    expect(screen.getByText('Pick a field to filter on.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await pickSelect('Filter field', 'Status')
    expect(screen.getByText('Enter a value to filter on.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: 'open' } })
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
  })

  it('produces a config listing the chosen filter and display columns', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={vi.fn()} onSubmit={onSubmit} />,
    )
    await pickWidgetType('list')
    await pickSelect('Filter field', 'Status')
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: 'open' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const call = onSubmit.mock.calls[0]![0]
    expect(call.type).toBe('list')
    expect(call.config.filterField).toBe('status')
    expect(call.config.filterValue).toBe('open')
    expect(Array.isArray(call.config.displayFields)).toBe(true)
    expect(call.config.displayFields.length).toBeGreaterThan(0)
  })
})

describe('WidgetConfigDialog: re-configuring an existing tile', () => {
  it('seeds the form from `initial` and submits under "Save"', async () => {
    const onSubmit = vi.fn()
    render(
      <WidgetConfigDialog
        open
        descriptor={descriptor}
        initial={{ type: 'stat', title: 'Deal count', config: { field: 'amount', aggregate: 'sum' } }}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )
    expect(screen.getByDisplayValue('Deal count')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: submitButtonName(true) })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'stat',
      title: 'Deal count',
      config: { field: 'amount', aggregate: 'sum' },
    })
  })
})

describe('WidgetConfigDialog: cancel', () => {
  it('closes without submitting', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(
      <WidgetConfigDialog open descriptor={descriptor} initial={null} onClose={onClose} onSubmit={onSubmit} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
