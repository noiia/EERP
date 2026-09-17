import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FormActionsMenu } from './form-actions-menu'
import { menuActionRegistry, registerMenuAction } from './menu-actions'
import type { MenuNode } from './descriptor'

afterEach(() => {
  menuActionRegistry.clear()
})

const printMenu: MenuNode[] = [
  {
    kind: 'submenu',
    label: 'Print',
    children: [{ kind: 'action', label: 'Invoice', action: 'sale.printInvoice' }],
  },
]

describe('FormActionsMenu', () => {
  it('is disabled with no declared actions', () => {
    render(<FormActionsMenu entity="invoice" actions={[]} recordId="r1" />)
    expect(screen.getByRole('button', { name: 'Options' })).toBeDisabled()
  })

  it('is disabled on an unsaved (new) record even with actions declared', () => {
    render(<FormActionsMenu entity="invoice" actions={printMenu} recordId="new" />)
    expect(screen.getByRole('button', { name: 'Options' })).toBeDisabled()
  })

  it('opens to reveal a submenu, and the submenu to reveal its action', () => {
    registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler: () => undefined })
    render(<FormActionsMenu entity="invoice" actions={printMenu} recordId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    expect(screen.getByRole('menuitem', { name: 'Print' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Print' }))
    expect(screen.getByRole('menuitem', { name: 'Invoice' })).toBeInTheDocument()
  })

  it('runs the registered handler with the entity and record id, closing the menu', async () => {
    const handler = vi.fn()
    registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler })
    render(<FormActionsMenu entity="invoice" actions={printMenu} recordId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Print' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Invoice' }))

    await waitFor(() => expect(handler).toHaveBeenCalledWith({ entity: 'invoice', recordId: 'r1' }))
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Invoice' })).not.toBeInTheDocument())
  })

  it('shows an inline error when the handler rejects', async () => {
    registerMenuAction({
      entity: 'invoice',
      name: 'sale.printInvoice',
      handler: () => Promise.reject(new Error('boom')),
    })
    render(<FormActionsMenu entity="invoice" actions={printMenu} recordId="r1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Print' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Invoice' }))

    expect(await screen.findByText('Action failed.')).toBeInTheDocument()
  })

  describe('onDelete — built-in entry, not a declared action', () => {
    it('with no onDelete, no Delete entry appears and the button stays disabled with zero declared actions', () => {
      render(<FormActionsMenu entity="invoice" actions={[]} recordId="r1" />)
      expect(screen.getByRole('button', { name: 'Options' })).toBeDisabled()
    })

    it('enables the button and shows Delete even with zero declared actions', () => {
      const onDelete = vi.fn()
      render(<FormActionsMenu entity="invoice" actions={[]} recordId="r1" onDelete={onDelete} />)
      expect(screen.getByRole('button', { name: 'Options' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Options' }))
      expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument()
    })

    it('clicking Delete calls onDelete and closes the menu, alongside declared actions', () => {
      const onDelete = vi.fn()
      registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler: () => undefined })
      render(<FormActionsMenu entity="invoice" actions={printMenu} recordId="r1" onDelete={onDelete} />)

      fireEvent.click(screen.getByRole('button', { name: 'Options' }))
      expect(screen.getByRole('menuitem', { name: 'Print' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))

      expect(onDelete).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument()
    })

    it('still disabled on an unsaved record even with onDelete given', () => {
      render(<FormActionsMenu entity="invoice" actions={[]} recordId="new" onDelete={vi.fn()} />)
      expect(screen.getByRole('button', { name: 'Options' })).toBeDisabled()
    })
  })
})
