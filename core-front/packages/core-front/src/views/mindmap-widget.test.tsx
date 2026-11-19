import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FieldDescriptor } from './descriptor'
import { RelationOpsProvider, type RelationOps } from './relation-ops'
import { fieldWidget } from './widgets'
import { centreBox } from './mindmap-widget'

vi.mock('./diagram/export', () => ({ exportElementPng: vi.fn() }))
import { exportElementPng } from './diagram/export'

const field: FieldDescriptor = {
  name: 'name',
  label: 'Name',
  type: 'text',
  widget: 'mindmap',
  widgetOptions: {
    satellites: [
      { field: 'category_id', label: 'Risk category', entity: 'project_risk_category' },
      { field: 'description', label: 'Risk type' },
      { field: 'phase_task_id', label: 'Project phase', entity: 'project_task', under: 'phase_note' },
      { field: 'owner', label: 'Owner' },
    ],
  },
}

function setup() {
  const ops = {
    list: vi.fn(async (entity: string) =>
      entity === 'project_risk_category' ? [{ id: 'c1', name: 'Technical' }] : [{ id: 't1', name: 'Design' }],
    ),
  } as unknown as RelationOps
  const Widget = fieldWidget(field)
  render(
    <RelationOpsProvider ops={ops}>
      <Widget
        field={field}
        value="Budget cut"
        onChange={vi.fn()}
        draft={{ description: 'Client trims scope', category_id: 'c1', phase_task_id: 't1', phase_note: 'Q2' }}
      />
    </RelationOpsProvider>,
  )
}

describe('text/mindmap', () => {
  it('draws centre, satellites with resolved labels, dashes for empties', async () => {
    setup()
    expect(screen.getByText('Budget cut')).toBeTruthy()
    expect(screen.getByText('Risk category')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Technical')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Design')).toBeTruthy())
    expect(screen.getByText('Client trims scope')).toBeTruthy()
    expect(screen.getByText('Q2')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('exports as PNG', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Export PNG' }))
    await waitFor(() => expect(exportElementPng).toHaveBeenCalled())
  })

  it.each([
    ['absent', undefined],
    ['empty', []],
    ['non-array', 'oops'],
    ['null entry', [null, 3, { label: 'no field' }]],
  ])('ignores malformed satellites (%s)', (_n, satellites) => {
    const f = { ...field, widgetOptions: satellites === undefined ? {} : { satellites } } as FieldDescriptor
    const Widget = fieldWidget(f)
    render(<Widget field={f} value="Centre" onChange={vi.fn()} draft={{}} />)
    expect(screen.getByText('Centre')).toBeTruthy()
  })

  it('shows the sibling named by the centre option instead of its own', () => {
    const f = { ...field, widgetOptions: { center: 'name' } } as FieldDescriptor
    const Widget = fieldWidget(f)
    render(<Widget field={f} value="own" onChange={vi.fn()} draft={{ name: 'Sibling' }} />)
    expect(screen.getByText('Sibling')).toBeTruthy()
    expect(screen.queryByText('own')).toBeNull()
  })

  it('sizes the centre box to its text: smaller font, bigger box, within bounds', () => {
    expect(centreBox('Budget cut')).toEqual({ font: 14, w: 180, h: 56 })
    const long = centreBox('Key supplier goes bankrupt before the second delivery and no alternative is qualified')
    expect(long.font).toBeLessThan(14)
    expect(long.w).toBeGreaterThan(180)
    expect(long.h).toBeGreaterThanOrEqual(56)
    const huge = centreBox('x'.repeat(2000))
    expect(huge).toEqual({ font: 11, w: 320, h: 220 })
    const f = { ...field, widgetOptions: { center: 'name' } } as FieldDescriptor
    const Widget = fieldWidget(f)
    render(<Widget field={f} value="" onChange={vi.fn()} draft={{ name: 'x'.repeat(120) }} />)
    expect(screen.getByText('x'.repeat(120))).toHaveStyle({ fontSize: '11px' })
  })
})
