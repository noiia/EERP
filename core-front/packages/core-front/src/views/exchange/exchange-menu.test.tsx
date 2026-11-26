import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ExchangeMenu } from './exchange-menu'
import { registerKanbanColumnsGuard } from '../kanban-columns'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import type { GanttExchangeConfig } from '../../api/view-fields'

const config: GanttExchangeConfig = {
  scopeField: 'project_id',
  scopeEntity: 'project',
  formats: [
    { key: 'gan', label: 'GanttProject (.gan)', accept: '.gan' },
    { key: 'mspdi', label: 'Microsoft Project (.xml)', accept: '.xml' },
  ],
  canImport: 'test.exchange-menu',
}

function renderMenu(variant: 'toolbar' | 'menuItems', can: boolean) {
  registerKanbanColumnsGuard('test.exchange-menu', async () => can)
  const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn() } as unknown as RelationOps
  render(
    <RelationOpsProvider ops={ops}>
      <ExchangeMenu config={config} scopeId="p1" variant={variant} onImported={vi.fn()} />
    </RelationOpsProvider>,
  )
}

afterEach(cleanup)

describe('ExchangeMenu', () => {
  it('menuItems lists an export per format, linked to the pinned scope, and an import per format', async () => {
    renderMenu('menuItems', true)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Plan file' }))
    expect(screen.getByRole('menuitem', { name: 'Export GanttProject (.gan)' })).toHaveAttribute('href', '/api/exchange/project/p1/gan/export')
    expect(screen.getByRole('menuitem', { name: 'Export Microsoft Project (.xml)' })).toHaveAttribute('href', '/api/exchange/project/p1/mspdi/export')
    expect(screen.getByRole('menuitem', { name: 'Import GanttProject (.gan)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import Microsoft Project (.xml)' }))
    expect(await screen.findByText('Import Microsoft Project (.xml)', { selector: 'h2' })).toBeInTheDocument()
  })

  it('menuItems hides Import when the guard is false', async () => {
    renderMenu('menuItems', false)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Plan file' }))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Export GanttProject (.gan)',
      'Export Microsoft Project (.xml)',
    ])
  })

  it('toolbar shows Import with both formats, only when the guard passes', async () => {
    renderMenu('toolbar', false)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull()
    cleanup()
    renderMenu('toolbar', true)
    fireEvent.click(await screen.findByRole('button', { name: 'Import' }))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['GanttProject (.gan)', 'Microsoft Project (.xml)'])
  })
})
