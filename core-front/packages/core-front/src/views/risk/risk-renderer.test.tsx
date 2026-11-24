import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../diagram/export', () => ({ exportElementPng: vi.fn(), exportElementPdf: vi.fn() }))
const pdfSave = vi.hoisted(() => vi.fn())
vi.mock('./register-export', () => ({ downloadRegister: vi.fn(), registerPdf: vi.fn(() => ({ save: pdfSave })) }))
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
const canWrite = vi.hoisted(() => ({ value: true }))
vi.mock('../../auth/Can', () => ({ usePermission: () => canWrite.value }))
const wizard = vi.hoisted(() => vi.fn())
vi.mock('../relation-widgets', async (orig) => ({
  ...(await orig<object>()),
  RelationCreateWizard: (p: { preset: unknown; onCreated: (r: unknown) => void }) => {
    wizard(p.preset)
    return <button onClick={() => p.onCreated({ id: 'new' })}>wizard-create</button>
  },
}))

import { RiskRenderer } from './risk-renderer'
import { exportElementPng as exportPng } from '../diagram/export'
import { downloadRegister, registerPdf } from './register-export'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { ApiError } from '../../api/errors'
import { setViewportWidth } from '../../test/viewport'

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
    expect(within(cell).getByText('6 - Late vendor')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'After remediation' }))
    expect(within(screen.getByTestId('cell-1:1')).getAllByText(/^1 - /).length).toBeGreaterThan(0)
  })

  it('draws one bone per category', async () => {
    setup(rows())
    fireEvent.click(await screen.findByRole('tab', { name: 'Ishikawa' }))
    const bone = await screen.findByTestId('bone-c1')
    expect(within(bone).getByText('Late vendor', { ignore: 'title' })).toBeTruthy()
    expect(within(screen.getByTestId('bone-c2')).getByText('Budget cut', { ignore: 'title' })).toBeTruthy()
    expect(screen.getByText('Apollo', { ignore: 'title' })).toBeTruthy()
  })

  it('opens a risk form on click', async () => {
    setup(rows())
    fireEvent.click(await screen.findByRole('tab', { name: 'Ishikawa' }))
    fireEvent.click(await screen.findByText('Late vendor', { ignore: 'title' }))
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

  it('names every chip while they fit, whatever their number', async () => {
    setup(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => risk(id)))
    const cell = await screen.findByTestId('cell-2:3')
    expect(within(cell).getAllByText(/^6 - [a-g]$/)).toHaveLength(7)
  })

  it('shows only the value once the named chips overflow the cell', async () => {
    const h = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200)
    const c = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(80)
    try {
      setup(['a', 'b', 'c', 'd'].map((id) => risk(id)))
      const cell = await screen.findByTestId('cell-2:3')
      expect(await within(cell).findAllByText('6')).toHaveLength(4)
    } finally {
      h.mockRestore()
      c.mockRestore()
    }
  })

  it('clips long Ishikawa labels and keeps the full name as tooltip', async () => {
    const long = 'A very long risk name that would overflow its bone box'
    setup([risk(long)])
    fireEvent.click(await screen.findByRole('tab', { name: 'Ishikawa' }))
    expect(await screen.findByText(/^A very long risk name.*…$/)).toBeTruthy()
    expect(screen.getByText(long).tagName.toLowerCase()).toBe('title')
  })

  it('creates a risk in the project and reloads', async () => {
    setup(rows())
    fireEvent.click(await screen.findByRole('button', { name: 'New risk' }))
    expect(wizard).toHaveBeenCalledWith({ project_id: 'p1' })
    fireEvent.click(screen.getByRole('button', { name: 'wizard-create' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'wizard-create' })).toBeNull())
  })

  it('hides New risk without write permission', async () => {
    canWrite.value = false
    setup(rows())
    expect(await screen.findByRole('tab', { name: 'Matrix' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New risk' })).toBeNull()
    canWrite.value = true
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

  it('exports the register as XLSX, CSV and PDF from the same table, names resolved', async () => {
    setup([risk('Late vendor', { responsible_id: 'u1' })])
    fireEvent.click(await screen.findByRole('tab', { name: 'Register' }))
    for (const [item, kind] of [['Export XLSX', 'xlsx'], ['Export CSV', 'csv']]) {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: item }))
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }))
      await waitFor(() => expect(downloadRegister).toHaveBeenLastCalledWith(kind, expect.anything(), 'register-p1', 'Risk register'))
    }
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export PDF' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(pdfSave).toHaveBeenCalledWith('register-p1.pdf'))
    expect(vi.mocked(registerPdf).mock.calls[0].slice(0, 2)).toEqual([[expect.objectContaining({ name: 'Late vendor' })], 'Apollo — Risk register'])
    const table = vi.mocked(downloadRegister).mock.calls[0][1]
    expect(table.heads[0]).toBe('Risk')
    expect(table.rows[0].slice(0, 3)).toEqual(['Late vendor', 'Internal', 'Delay'])
  })

  it('tints the register by criticity with the Temperature toggle, and exports the colors', async () => {
    setup(rows())
    fireEvent.click(await screen.findByRole('tab', { name: 'Register' }))
    const toggle = screen.getByRole('button', { name: 'Temperature' })
    expect(document.querySelector('[data-heat]')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const heat = [...document.querySelectorAll('[data-heat]')].map((e) => e.getAttribute('data-heat'))
    expect(heat[0]).toMatch(/^\d+,\d+,\d+$/)
    expect(heat[1]).toBe('') // no criticity, no color
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export XLSX' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(downloadRegister).toHaveBeenCalled())
    const { fills } = vi.mocked(downloadRegister).mock.calls[0][1]
    expect(fills).toHaveLength(2)
    expect(fills![0]).toHaveLength(3)
    expect(fills![1]).toBeNull()
  })

  it('colors the register relative to its rows: the highest criticity listed is red', async () => {
    setup([risk('A', { criticity: 9 }), risk('B', { criticity: 3 })])
    fireEvent.click(await screen.findByRole('tab', { name: 'Register' }))
    fireEvent.click(screen.getByRole('button', { name: 'Temperature' }))
    const [hi, lo] = [...document.querySelectorAll('tr[data-heat]')].map((e) => e.getAttribute('data-heat')!.split(',').map(Number))
    expect(hi[0]).toBeGreaterThan(200) // red, though 9 is far from the maximal 36
    expect(lo[1]).toBeGreaterThan(lo[0]) // green
  })

  it('exports only the selected risks, recoloring on the selection', async () => {
    setup([risk('A', { criticity: 9 }), risk('B', { criticity: 3 }), risk('C', { criticity: 6 })])
    fireEvent.click(await screen.findByRole('tab', { name: 'Register' }))
    fireEvent.click(screen.getByRole('button', { name: 'Temperature' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export XLSX' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getAllByRole('checkbox').every((c) => (c as HTMLInputElement).checked)).toBe(true)
    fireEvent.click(dialog.getByRole('button', { name: 'Clear selection' }))
    expect(dialog.getByRole('button', { name: 'Export' })).toBeDisabled()
    fireEvent.click(dialog.getByRole('button', { name: 'Select all' }))
    expect(dialog.getAllByRole('checkbox').every((c) => (c as HTMLInputElement).checked)).toBe(true)
    fireEvent.click(dialog.getByRole('checkbox', { name: '9 - A' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(downloadRegister).toHaveBeenCalled())
    const { rows: out, fills } = vi.mocked(downloadRegister).mock.calls[0][1]
    expect(out.map((r) => r[0])).toEqual(['B', 'C'])
    // C (6) is now the highest exported: it takes the red end, tinted.
    expect(fills![1]![0]).toBeGreaterThan(fills![1]![2])
    expect(fills![0]![1]).toBeGreaterThan(fills![0]![0])
  })

  it('exports the selected register rows as a PNG', async () => {
    let captured = ''
    vi.mocked(exportPng).mockImplementationOnce(async (el: HTMLElement) => {
      captured = el.textContent ?? ''
      expect(el.dataset.testid).toBe('register-export')
    })
    setup([risk('A', { criticity: 9 }), risk('B', { criticity: 3 })])
    fireEvent.click(await screen.findByRole('tab', { name: 'Register' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export PNG' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('checkbox', { name: '3 - B' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(exportPng).toHaveBeenCalledTimes(1))
    expect(captured).toContain('Apollo — Risk register')
    expect(captured).toContain('R1A')
    expect(captured).not.toContain('R2')
    for (const h of ['Remediation', 'If it happens', 'Criticity', 'Residual']) expect(captured).toContain(h)
    // Always the light sheet, whatever the theme.
    expect(vi.mocked(exportPng).mock.calls[0][2]).toBe('#ffffff')
    await waitFor(() => expect(screen.queryByTestId('register-export')).toBeNull())
  })

  it('exports the matrix with the current and after-remediation versions in one image', async () => {
    let captured = ''
    vi.mocked(exportPng).mockImplementationOnce(async (el: HTMLElement) => {
      captured = el.textContent ?? ''
      expect(el.dataset.testid).toBe('matrix-export')
      // Freshly mounted chips must be drawn at once: no entrance animation inside the capture.
      const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n')
      expect(css).toMatch(/animation:\s*none\s*!important/)
    })
    setup(rows())
    await screen.findByTestId('cell-2:3')
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export PNG' }))
    await waitFor(() => expect(exportPng).toHaveBeenCalledTimes(1))
    // Both titles, and Late vendor plotted at 6 (current) and at 1 (after remediation).
    expect(captured).toContain('Current')
    expect(captured).toContain('After remediation')
    expect(captured).toContain('6 - Late vendor')
    expect(captured).toContain('1 - Late vendor')
    await waitFor(() => expect(screen.queryByTestId('matrix-export')).toBeNull())
  })

  it('shows the risk on hover: scores, remediation and if it happens', async () => {
    setup([risk('Late vendor', { detectability: 1, remediation: 'Second supplier', if_it_happens: 'Switch supplier' })])
    fireEvent.mouseOver(within(await screen.findByTestId('cell-2:3')).getByText('6 - Late vendor'))
    const tip = await screen.findByTestId('risk-tip')
    for (const text of ['Late vendor', 'Likelihood :', 'Severity :', 'Detectability :', 'Criticity :', 'Second supplier', 'If it happens', 'Switch supplier']) {
      expect(within(tip).getByText(text)).toBeTruthy()
    }
    const crit = within(tip).getByText('6').parentElement as HTMLElement
    expect(crit.textContent).toBe('6 → 1')
    expect(getComputedStyle(within(crit).getByText('6')).fontWeight).toBe('700')
    expect(getComputedStyle(within(crit).getByText('1')).fontWeight).toBe('400')
  })

  describe('phone', () => {
    it('puts full-width tabs on their own row and actions below', async () => {
      setViewportWidth(390)
      setup(rows())
      const tabs = (await screen.findByRole('tablist')).closest('.MuiTabs-root') as HTMLElement
      expect(tabs.querySelector('.MuiTabs-fixed')).toBeTruthy()
      expect(screen.getByRole('tab', { name: 'Matrix' }).className).toContain('MuiTab-fullWidth')
      const row = screen.getByRole('button', { name: 'New risk' }).parentElement as HTMLElement
      expect(row.contains(tabs)).toBe(false)
      expect(tabs.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Now' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'After' })).toBeTruthy()
    })

    it('fits the matrix in the screen with short chip labels', async () => {
      setViewportWidth(390)
      setup([risk('A very long risk name')])
      const cell = await screen.findByTestId('cell-2:3')
      expect((cell.parentElement as HTMLElement).style.gridTemplateColumns || getComputedStyle(cell.parentElement as HTMLElement).gridTemplateColumns).toContain('minmax(0px, 1fr)')
      const chip = within(cell).getByRole('button')
      expect(chip.textContent).toBe('6 - A very long …')
      expect(chip.getAttribute('aria-label')).toBe('6 - A very long risk name')
      expect(getComputedStyle(chip).minHeight).toBe('40px')
      expect(screen.getByText('L3').getAttribute('title')).toBe('Likelihood 3')
      expect(screen.getByText('S4').getAttribute('title')).toBe('Severity 4')
      expect(screen.queryByText('Likelihood 3')).toBeNull()
    })

    it('shows the register as cards that open the form', async () => {
      setViewportWidth(390)
      setup(rows())
      fireEvent.click(await screen.findByRole('tab', { name: 'Register' }))
      const items = await screen.findAllByRole('listitem')
      expect(items).toHaveLength(2)
      expect(screen.queryByRole('table')).toBeNull()
      expect(within(items[0]).getByText('Late vendor')).toBeTruthy()
      expect(within(items[0]).getByText('Internal')).toBeTruthy()
      const card = within(items[0]).getByRole('button')
      expect(getComputedStyle(card).minHeight).toBe('40px')
      fireEvent.click(card)
      expect(push).toHaveBeenCalledWith('/app/project/risks/Late vendor')
      push.mockClear()
      card.focus()
      fireEvent.keyDown(card, { key: 'Enter' })
      expect(push).toHaveBeenCalledWith('/app/project/risks/Late vendor')
    })
  })

  it('keeps the desktop table and 120px matrix columns', async () => {
    setup(rows())
    const cell = await screen.findByTestId('cell-2:3')
    expect((cell.parentElement as HTMLElement).style.gridTemplateColumns || getComputedStyle(cell.parentElement as HTMLElement).gridTemplateColumns).toContain('120px')
    fireEvent.click(screen.getByRole('tab', { name: 'Register' }))
    expect(await screen.findByRole('table')).toBeTruthy()
  })
})
