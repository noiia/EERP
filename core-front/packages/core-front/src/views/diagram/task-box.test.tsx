import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { FieldDescriptor } from '../descriptor'
import { useFormatStore } from '../format-store'
import { ForceDetail, TaskBox, type TaskBoxData } from './task-box'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }))
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  useStore: (sel: (s: unknown) => unknown) => sel({ transform: [0, 0, 1], width: 0, height: 0 }),
}))

const fields: FieldDescriptor[] = [
  { name: 'name', label: 'Name', type: 'text' },
  { name: 'stage_id', label: 'Stage', type: 'relation', relation: { entity: 'project_stage', kind: 'many2one' } },
  { name: 'deadline', label: 'Deadline', type: 'date' },
  { name: 'planned_hours', label: 'Planned', type: 'number' },
  { name: 'notes', label: 'Notes', type: 'text' },
]
const long = 'A very long task name that an input would clip, wrapped on several lines in the export'

function box(exporting: boolean, data: Partial<TaskBoxData> = {}) {
  const props = {
    id: 'A',
    data: {
      record: { id: 'A', name: long, stage_id: 's1', deadline: '2026-06-15', planned_hours: 1234.5, notes: '' },
      editable: true,
      fields,
      onCommit: vi.fn(),
      onOpen: vi.fn(),
      onRemove: vi.fn(),
      relationLabel: (_f: string, v: unknown) => (v === 's1' ? 'In progress' : ''),
      ...data,
    },
  } as unknown as ComponentProps<typeof TaskBox>
  render(
    <ForceDetail.Provider value={exporting}>
      <TaskBox {...props} />
    </ForceDetail.Provider>,
  )
}

afterEach(cleanup)

describe('TaskBox export', () => {
  it('prints every field as wrapping text, many2one by its label, with no input and no trash', () => {
    useFormatStore.setState({ dateFormat: 'dd/MM/yyyy' })
    box(true)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryByLabelText('Remove from diagram')).toBeNull()
    const name = within(screen.getByTestId('export-field-name'))
    expect(name.getByText('Name')).toBeInTheDocument()
    expect(name.getByText(long)).toHaveStyle({ whiteSpace: 'pre-wrap' })
    expect(within(screen.getByTestId('export-field-stage_id')).getByText('In progress')).toBeInTheDocument()
    expect(within(screen.getByTestId('export-field-deadline')).getByText('15/06/2026')).toBeInTheDocument()
    expect(within(screen.getByTestId('export-field-planned_hours')).getByText(/1.?234/)).toBeInTheDocument()
    expect(within(screen.getByTestId('export-field-notes')).getByText('—')).toBeInTheDocument()
  })

  it('falls back to the raw id when no label resolves, and keeps the widgets on screen', () => {
    box(true, { relationLabel: undefined })
    expect(within(screen.getByTestId('export-field-stage_id')).getByText('s1')).toBeInTheDocument()
    cleanup()
    box(false)
    expect(screen.queryByTestId('export-field-name')).toBeNull()
    expect(screen.getByLabelText('Remove from diagram')).toBeInTheDocument()
  })
})
