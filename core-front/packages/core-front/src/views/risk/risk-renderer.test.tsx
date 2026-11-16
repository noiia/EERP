import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../diagram/export', () => ({ exportElementPng: vi.fn(), exportElementPdf: vi.fn() }))
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

import { RiskRenderer } from './risk-renderer'
import { exportElementPng as exportPng } from '../diagram/export'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { ApiError } from '../../api/errors'

const config = { entity: 'project_risk', linkEntity: 'project_risk_task', categoryEntity: 'project_risk_category', projectField: 'project_id', formPath: '/project/risks/:id' }
const risk = (id: string, o: Record<string, unknown> = {}) => ({
  id, name: id, category_id: 'c1', impact_on: 'delay', likelihood: 2, severity_effective: 3, criticity: 6,
  residual_likelihood: 1, residual_severity: 1, residual_criticity: 1, severity_note: null, ...o,
})

function setup(rows: unknown[], fail = false) {
  const ops = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ id: 'p1', name: 'Apollo' })),
    listPage: vi.fn(async (e: string) => {
      if (e === 'project_risk' && fail) throw new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 })
      if (e === 'project_risk') return { records: rows, total: rows.length }
      if (e === 'project_risk_category') return { records: [{ id: 'c1', name: 'Internal', color: '#ff0000' }, { id: 'c2', name: 'Financial', color: '#00ff00' }], total: 2 }
      return { records: [], total: 0 }
    }),
  } as unknown as RelationOps
  render(<RelationOpsProvider ops={ops}><RiskRenderer config={config} projectId="p1" /></RelationOpsProvider>)
}
const rows = () => [risk('Late vendor'), risk('Budget cut', { category_id: 'c2', severity_note: 'cycle', severity_effective: null, criticity: null })]

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('RiskRenderer', () => {
  it('renders the three tabs', async () => {
    setup(rows())
    for (const n of ['Matrix', 'Ishikawa', 'Register']) expect(await screen.findByRole('tab', { name: n })).toBeTruthy()
  })

  it('places the chip in its cell and moves it with the residual toggle', async () => {
    setup(rows())
    const cell = await screen.findByTestId('cell-2:3')
    expect(within(cell).getByText('6')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'After remediation' }))
    expect(within(screen.getByTestId('cell-1:1')).getAllByText('1').length).toBeGreaterThan(0)
  })

  it('draws one bone per category', async () => {
    setup(rows())
    fireEvent.click(await screen.findByRole('tab', { name: 'Ishikawa' }))
    const bone = await screen.findByTestId('bone-c1')
    expect(within(bone).getByText('Late vendor')).toBeTruthy()
    expect(within(screen.getByTestId('bone-c2')).getByText('Budget cut')).toBeTruthy()
    expect(screen.getByText('Apollo')).toBeTruthy()
  })

  it('opens a risk form on click', async () => {
    setup(rows())
    fireEvent.click(await screen.findByRole('tab', { name: 'Ishikawa' }))
    fireEvent.click(await screen.findByText('Late vendor'))
    expect(push).toHaveBeenCalledWith('/app/project/risks/Late vendor')
  })

  it('shows Not computable in the register', async () => {
    setup(rows())
    fireEvent.click(await screen.findByRole('tab', { name: 'Register' }))
    expect(await screen.findByText('Not computable')).toBeTruthy()
    expect(screen.getByText('Financial')).toBeTruthy()
  })

  it('shows the error alert when the read fails', async () => {
    setup([], true)
    expect(await screen.findByText(/nope/)).toBeTruthy()
  })

  it('exports PNG from Matrix and Ishikawa', async () => {
    setup(rows())
    for (const tab of ['Matrix', 'Ishikawa']) {
      fireEvent.click(await screen.findByRole('tab', { name: tab }))
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Export PNG' }))
    }
    await waitFor(() => expect(exportPng).toHaveBeenCalledTimes(2))
  })
})
