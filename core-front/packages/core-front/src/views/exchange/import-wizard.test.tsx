import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { ImportWizard } from './import-wizard'
import type { ExchangeChange } from './selection'
import type { ExchangeFormat, GanttExchangeConfig } from '../../api/view-fields'

const format: ExchangeFormat = { key: 'gan', label: 'GanttProject (.gan)', accept: '.gan' }
const config: GanttExchangeConfig = {
  scopeField: 'project_id',
  scopeEntity: 'project',
  formats: [format, { key: 'mppdi', label: 'MS Project (MSPDI)', accept: '.xml' }],
  canImport: 'test.exchange',
}

const PREVIEW = '/api/exchange/project/p1/gan/preview'
const APPLY = '/api/exchange/project/p1/gan/apply'

/** The short date the review list prints (the Gantt bar tooltips' own format). */
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).toLocaleDateString()

const row = (over: Partial<ExchangeChange> & { key: string; kind: string; task: string }): ExchangeChange => ({
  wbs: undefined,
  field: undefined,
  before: null,
  after: null,
  default_selected: true,
  requires: undefined,
  was_unscheduled: undefined,
  dependents: undefined,
  ...over,
})

const datesRow = row({
  key: 'task:t1:dates',
  kind: 'update',
  task: 'Design review',
  wbs: '2.1',
  field: 'dates',
  before: { start: '2026-03-12', end: '2026-03-12' },
  after: { start: '2026-03-19', end: '2026-03-19' },
})
const hoursRow = row({
  key: 'task:t1:planned_hours',
  kind: 'update',
  task: 'Design review',
  wbs: '2.1',
  field: 'planned_hours',
  before: 16,
  after: 24,
})
const createRow = row({
  key: 'new:7',
  kind: 'create',
  task: 'Supplier audit',
  wbs: '2.3',
  after: { name: 'Supplier audit', parent: 'Design', start: '2026-03-05', end: '2026-03-07', planned_hours: 8 },
})
const depRow = row({
  key: 'dep:t1:new:7',
  kind: 'dependency',
  task: 'Supplier audit',
  wbs: '2.3',
  after: { pred: 't1', pred_name: 'Design review', succ: 'new:7', succ_name: 'Supplier audit' },
  requires: ['new:7'],
})
const deleteRow = row({
  key: 'task:t9:delete',
  kind: 'delete',
  task: 'Legacy migration',
  wbs: '3.4',
  default_selected: false,
  dependents: { subtasks: 3, timesheets: 2, risk_links: 0 },
})

const CHANGES = [datesRow, hoursRow, createRow, depRow, deleteRow]
const WARNINGS = [
  { code: 'DEP_TYPE', message: 'dependency types and lags are not carried' },
  { code: 'UNKNOWN_ID', message: 'a task id is unknown here and arrives as a new task' },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const previewOK = (changes = CHANGES, warnings = WARNINGS, base = 'hash1') => json({ base, changes, warnings })

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

function renderWizard(onApplied = vi.fn()) {
  render(
    <ImportWizard open onClose={vi.fn()} onApplied={onApplied} config={config} scopeId="p1" format={format} />,
  )
  return onApplied
}

function pickFile() {
  const input = screen.getByLabelText('Plan file')
  fireEvent.change(input, { target: { files: [new File(['<project/>'], 'plan.gan', { type: 'application/xml' })] } })
}

const checkbox = (key: string) => within(screen.getByTestId(`exchange-row-${key}`)).getByRole('checkbox')
const rowEl = (key: string) => screen.getByTestId(`exchange-row-${key}`)

describe('ImportWizard', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('step 1 offers the file picker with the format accept and label', () => {
    renderWizard()
    expect(screen.getByText('Import GanttProject (.gan)')).toBeInTheDocument()
    expect(screen.getByLabelText('Plan file')).toHaveAttribute('accept', '.gan')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the preview renders the rows grouped, and the removals start unticked', async () => {
    fetchMock.mockResolvedValue(previewOK())
    renderWizard()
    pickFile()
    // Grouped by task/WBS, the added task marked as such.
    expect(await screen.findByText('2.1 Design review')).toBeInTheDocument()
    expect(screen.getByText('2.3 Supplier audit (new)')).toBeInTheDocument()
    expect(screen.getByText('3.4 Legacy migration')).toBeInTheDocument()
    expect(within(screen.getByTestId('exchange-group-Legacy migration')).getAllByRole('checkbox')).toHaveLength(1)
    // The four additive rows ticked, the removal not.
    for (const key of [datesRow.key, hoursRow.key, createRow.key, depRow.key]) {
      expect(checkbox(key)).toBeChecked()
    }
    expect(checkbox(deleteRow.key)).not.toBeChecked()
    expect(screen.getByText('4 of 5 selected')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(PREVIEW, expect.objectContaining({ method: 'POST' }))
  })

  it('a row reads its kind, field, and before → after in the workspace formats', async () => {
    fetchMock.mockResolvedValue(previewOK())
    renderWizard()
    pickFile()
    await screen.findByText('2.1 Design review')
    expect(within(rowEl(datesRow.key)).getByText('Update')).toBeInTheDocument()
    expect(within(rowEl(datesRow.key)).getByText(`${day(2026, 3, 12)} – ${day(2026, 3, 12)}`)).toBeInTheDocument()
    expect(within(rowEl(datesRow.key)).getByText(`${day(2026, 3, 19)} – ${day(2026, 3, 19)}`)).toBeInTheDocument()
    expect(within(rowEl(hoursRow.key)).getByText('16')).toBeInTheDocument()
    expect(within(rowEl(hoursRow.key)).getByText('24')).toBeInTheDocument()
    expect(within(rowEl(createRow.key)).getByText('Create')).toBeInTheDocument()
    expect(within(rowEl(createRow.key)).getByText(/Supplier audit/)).toBeInTheDocument()
    expect(within(rowEl(createRow.key)).getByText(/8 h/)).toBeInTheDocument()
    // A create also says whose child it becomes: the wireframe's "Create under 2 · Design"
    // is the half of a new task a manager actually decides, and it used to be dropped.
    expect(within(rowEl(createRow.key)).getByText(/under Design/)).toBeInTheDocument()
    expect(within(rowEl(depRow.key)).getByText('Depends on')).toBeInTheDocument()
    expect(within(rowEl(depRow.key)).getByText('Design review → Supplier audit')).toBeInTheDocument()
    // A removal names what goes with it, and leaves the zero count out.
    expect(within(rowEl(deleteRow.key)).getByText('has 2 timesheets, 3 subtasks')).toBeInTheDocument()
    expect(within(rowEl(deleteRow.key)).queryByText(/risk link/)).not.toBeInTheDocument()
    // The row checkbox says which row it is, not just "Select change".
    expect(checkbox(datesRow.key)).toHaveAccessibleName(/Select change.*Design review/)
  })

  it('a removal with one dependent says 1, not a literal {n}', async () => {
    fetchMock.mockResolvedValue(
      previewOK(
        [
          row({
            key: 'task:t9:delete',
            kind: 'delete',
            task: 'Legacy migration',
            wbs: '3.4',
            default_selected: false,
            dependents: { subtasks: 1, timesheets: 1, risk_links: 1 },
          }),
        ],
        [],
      ),
    )
    renderWizard()
    pickFile()
    await screen.findByText('3.4 Legacy migration')
    // The one-form is a literal "1" (the PERT chip's idiom), not a template to substitute.
    expect(within(rowEl('task:t9:delete')).getByText('has 1 timesheet, 1 risk link, 1 subtask')).toBeInTheDocument()
    expect(rowEl('task:t9:delete').textContent).not.toContain('{n}')
  })

  it('keeps two distinct tasks that share a name in separate groups', async () => {
    fetchMock.mockResolvedValue(
      previewOK(
        [
          row({ key: 'task:tA:planned_hours', kind: 'update', task: 'Design review', wbs: '2.1', field: 'planned_hours', before: 8, after: 16 }),
          row({ key: 'task:tB:planned_hours', kind: 'update', task: 'Design review', wbs: '9.9', field: 'planned_hours', before: 4, after: 6 }),
        ],
        [],
      ),
    )
    renderWizard()
    pickFile()
    // Same name, two tasks: each header keeps its own WBS, no merge.
    expect(await screen.findByText('2.1 Design review')).toBeInTheDocument()
    expect(screen.getByText('9.9 Design review')).toBeInTheDocument()
    expect(within(rowEl('task:tB:planned_hours')).getByText('6')).toBeInTheDocument()
  })

  it('says when a dates row is really the first schedule a task ever had', async () => {
    fetchMock.mockResolvedValue(
      previewOK([row({ ...datesRow, was_unscheduled: true, before: { start: '2026-03-02', end: '2026-03-02' } })]),
    )
    renderWizard()
    pickFile()
    await screen.findByText('2.1 Design review')
    expect(within(rowEl(datesRow.key)).getByText('(was unscheduled)')).toBeInTheDocument()
  })

  it('the warnings sit collapsed behind their count', async () => {
    fetchMock.mockResolvedValue(previewOK())
    renderWizard()
    pickFile()
    await screen.findByText('2.1 Design review')
    expect(screen.queryByText(/dependency types and lags/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '2 warnings' }))
    expect(await screen.findByText(/dependency types and lags/)).toBeInTheDocument()
    expect(screen.getByText(/arrives as a new task/)).toBeInTheDocument()
  })

  it('an empty preview says so and cannot be applied', async () => {
    fetchMock.mockResolvedValue(previewOK([], []))
    renderWizard()
    pickFile()
    expect(await screen.findByText('No changes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply 0 changes' })).toBeDisabled()
  })

  it('Select all never ticks a removal; Select all removals ticks them', async () => {
    fetchMock.mockResolvedValue(
      previewOK([...CHANGES, row({ key: 'task:t8:delete', kind: 'delete', task: 'Old report', wbs: '3.5', default_selected: false })]),
    )
    renderWizard()
    pickFile()
    await screen.findByText('2.1 Design review')
    // Untick one additive row: the header checkbox is no longer all-on.
    fireEvent.click(checkbox(datesRow.key))
    expect(screen.getByText('3 of 6 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(checkbox(datesRow.key)).toBeChecked()
    expect(checkbox(deleteRow.key)).not.toBeChecked()
    expect(checkbox('task:t8:delete')).not.toBeChecked()
    expect(screen.getByText('4 of 6 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all removals' }))
    expect(checkbox(deleteRow.key)).toBeChecked()
    expect(checkbox('task:t8:delete')).toBeChecked()
    expect(screen.getByText('6 of 6 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all removals' }))
    expect(checkbox(deleteRow.key)).not.toBeChecked()
    expect(checkbox(datesRow.key)).toBeChecked()
  })

  it('ticking a dependency on a new task ticks its create', async () => {
    fetchMock.mockResolvedValue(previewOK([createRow, depRow], []))
    renderWizard()
    pickFile()
    await screen.findByText('2.3 Supplier audit (new)')
    fireEvent.click(checkbox(createRow.key)) // untick the create: the dep that needs it goes too
    expect(checkbox(depRow.key)).not.toBeChecked()
    expect(screen.getByText('0 of 2 selected')).toBeInTheDocument()
    fireEvent.click(checkbox(depRow.key))
    expect(checkbox(createRow.key)).toBeChecked()
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()
  })

  it('Apply posts the file, the base and exactly the ticked keys', async () => {
    fetchMock.mockResolvedValue(json({ applied: 4 }))
    fetchMock.mockResolvedValueOnce(previewOK())
    const onApplied = renderWizard()
    pickFile()
    await screen.findByText('2.1 Design review')
    fireEvent.click(checkbox(hoursRow.key)) // untick one
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(APPLY, expect.objectContaining({ method: 'POST' })))
    const form = fetchMock.mock.calls.at(-1)![1]!.body as FormData
    expect(form.get('base')).toBe('hash1')
    expect((form.get('file') as File).name).toBe('plan.gan')
    expect(form.getAll('keys')).toEqual([datesRow.key, createRow.key, depRow.key])
    expect(await screen.findByText('4 changes applied')).toBeInTheDocument()
    expect(onApplied).toHaveBeenCalled()
  })

  it('a 413 says the file is too large', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 413 }))
    renderWizard()
    pickFile()
    expect(await screen.findByText('The file is too large.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply 4 changes' })).toBeNull()
  })

  it('any other preview refusal shows the error', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'INVALID_FILE', message: 'the file is not a plan EERP can read' } }, 422))
    renderWizard()
    pickFile()
    expect(await screen.findByText('INVALID_FILE')).toBeInTheDocument()
    expect(screen.queryByText('2.1 Design review')).toBeNull()
  })

  it('a 409 offers Preview again, which re-posts the preview with the same file', async () => {
    fetchMock
      .mockResolvedValueOnce(previewOK())
      .mockResolvedValueOnce(json({ error: { code: 'PROJECT_CHANGED', message: 'the project changed since the preview' } }, 409))
      .mockResolvedValueOnce(previewOK([{ ...datesRow }], []))
    renderWizard()
    pickFile()
    await screen.findByText('2.1 Design review')
    fireEvent.click(screen.getByRole('button', { name: 'Apply 4 changes' }))
    expect(await screen.findByText('The project changed since the preview')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview again' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(fetchMock.mock.calls[2]![0]).toBe(PREVIEW)
    const form = fetchMock.mock.calls[2]![1]!.body as FormData
    expect((form.get('file') as File).name).toBe('plan.gan')
    // Back in review against the fresh base, with the list rebuilt.
    expect(await screen.findByText('1 of 1 selected')).toBeInTheDocument()
  })

  it('a 422 returns to the review with the message and the named rows highlighted', async () => {
    fetchMock
      .mockResolvedValueOnce(previewOK())
      .mockResolvedValueOnce(
        json({ code: 'VALIDATION_ERROR', error: { code: 'VALIDATION_ERROR', message: 'a parent delete needs its child deletes', request_id: 'req-42', fields: [deleteRow.key, depRow.key] } }, 422),
      )
    renderWizard()
    pickFile()
    await screen.findByText('2.1 Design review')
    fireEvent.click(checkbox(deleteRow.key))
    fireEvent.click(screen.getByRole('button', { name: 'Apply 5 changes' }))
    expect(await screen.findByText('a parent delete needs its child deletes')).toBeInTheDocument()
    // The admin can find the log line: the Banner carries the code and the request id.
    expect(screen.getByText('VALIDATION_ERROR')).toBeInTheDocument()
    expect(screen.getByText(/req-42/)).toBeInTheDocument()
    expect(rowEl(deleteRow.key)).toHaveAttribute('data-highlighted', 'true')
    expect(rowEl(depRow.key)).toHaveAttribute('data-highlighted', 'true')
    expect(rowEl(datesRow.key)).not.toHaveAttribute('data-highlighted')
    // Still on the review, the ticks kept: the manager fixes them and tries again.
    expect(screen.getByText('5 of 5 selected')).toBeInTheDocument()
  })

  it('reads every value shape the diff sends', async () => {
    // The keys are the UUIDs the server really sends (a move's parent/after are task ids)
    // and the names are the display-only half it sends beside them: what the manager must
    // see is the name, never the id. Readable fixture keys here used to pin the broken
    // render, which printed the key as if it were a name.
    const parent = '3f2a1b6c-0000-4000-8000-000000000001'
    const after = '9b1c2d3e-0000-4000-8000-000000000002'
    fetchMock.mockResolvedValue(
      previewOK(
        [
          row({
            key: 'task:mv:parent',
            kind: 'move',
            task: 'Design review',
            wbs: '2.1',
            field: 'parent',
            after: { parent, parent_name: 'Design phase', after, after_name: 'Build' },
          }),
          row({
            key: 'new:c1',
            kind: 'create',
            task: 'Supplier audit',
            wbs: '2.3',
            after: { name: 'Supplier audit', parent, parent_name: 'Design phase', start: '2026-03-05', end: '2026-03-07', planned_hours: 8 },
          }),
          row({ key: 'assign:u4:dev@x.io', kind: 'assign', task: 'Design review', wbs: '2.1', field: undefined, after: { task: 't1', email: 'dev@x.io', name: 'Dev' } }),
          row({ key: 'task:cl:closed', kind: 'update', task: 'Design review', wbs: '2.1', field: 'closed', before: false, after: true }),
          row({ key: 'milestone:m1:create', kind: 'milestone_create', task: 'Gate', wbs: '2.2', field: undefined, after: { id: 'm1', name: 'Sign-off' } }),
        ],
        [],
      ),
    )
    renderWizard()
    pickFile()
    await screen.findByText('2.1 Design review')
    expect(within(rowEl('task:mv:parent')).getByText('under Design phase, after Build')).toBeInTheDocument()
    expect(within(rowEl('new:c1')).getByText(/under Design phase/)).toBeInTheDocument()
    // Not one identifier of the two rows reaches the manager's eyes.
    expect(screen.queryByText(/3f2a1b6c/)).toBeNull()
    expect(screen.queryByText(/9b1c2d3e/)).toBeNull()
    expect(within(rowEl('assign:u4:dev@x.io')).getByText('Dev')).toBeInTheDocument()
    expect(within(rowEl('task:cl:closed')).getByText('No')).toBeInTheDocument()
    expect(within(rowEl('task:cl:closed')).getByText('Yes')).toBeInTheDocument()
    expect(within(rowEl('milestone:m1:create')).getByText('Sign-off')).toBeInTheDocument()
  })

  it('a transport failure shows the error rather than an empty review', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    renderWizard()
    pickFile()
    expect(await screen.findByText('INTERNAL_ERROR')).toBeInTheDocument()
    expect(screen.queryByText('2.1 Design review')).toBeNull()
  })

  it('Back returns to the file picker', async () => {
    fetchMock.mockResolvedValue(previewOK())
    renderWizard()
    pickFile()
    await screen.findByText('2.1 Design review')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByText('2.1 Design review')).toBeNull()
    expect(screen.getByLabelText('Plan file')).toBeInTheDocument()
  })

  it('a failed apply keeps the review and reports the server error', async () => {
    fetchMock
      .mockResolvedValueOnce(previewOK())
      .mockResolvedValue(json({ error: { code: 'INTERNAL_ERROR', message: 'the write failed' } }, 500))
    const onApplied = renderWizard()
    pickFile()
    await screen.findByText('2.1 Design review')
    fireEvent.click(screen.getByRole('button', { name: 'Apply 4 changes' }))
    expect(await screen.findByText('INTERNAL_ERROR')).toBeInTheDocument()
    expect(screen.getByText('2.1 Design review')).toBeInTheDocument()
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('Done closes the wizard, as the toolbar Close button does', async () => {
    const onClose = vi.fn()
    fetchMock.mockResolvedValue(json({ applied: 4 }))
    fetchMock.mockResolvedValueOnce(previewOK())
    render(
      <ImportWizard open onClose={onClose} onApplied={vi.fn()} config={config} scopeId="p1" format={format} />,
    )
    pickFile()
    await screen.findByText('2.1 Design review')
    fireEvent.click(screen.getByRole('button', { name: 'Apply 4 changes' }))
    expect(await screen.findByText('4 changes applied')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('is full screen on phone', async () => {
    const { setViewportWidth } = await import('../../test/viewport')
    setViewportWidth(390)
    renderWizard()
    expect(document.querySelector('.MuiDialog-paperFullScreen')).not.toBeNull()
  })

})
