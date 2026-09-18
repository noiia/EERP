import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FormActionsMenu, type FormActionsMenuProps } from './form-actions-menu'
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

/** draft/onFieldsCommit default to an empty draft and a no-op — most tests
 * here only care about actions/recordId/onDelete; override either when a
 * test actually exercises MenuActionContext's own draft/setFieldAndCommit. */
function renderMenu(props: Partial<FormActionsMenuProps> & Pick<FormActionsMenuProps, 'actions' | 'recordId'>) {
  render(
    <FormActionsMenu
      entity="invoice"
      draft={{}}
      onFieldsCommit={vi.fn(async () => null)}
      {...props}
    />,
  )
}

describe('FormActionsMenu', () => {
  it('is disabled with no declared actions', () => {
    renderMenu({ actions: [], recordId: 'r1' })
    expect(screen.getByRole('button', { name: 'Options' })).toBeDisabled()
  })

  it('is disabled on an unsaved (new) record even with actions declared', () => {
    renderMenu({ actions: printMenu, recordId: 'new' })
    expect(screen.getByRole('button', { name: 'Options' })).toBeDisabled()
  })

  it('opens to reveal a submenu, and the submenu to reveal its action', () => {
    registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler: () => undefined })
    renderMenu({ actions: printMenu, recordId: 'r1' })

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    expect(screen.getByRole('menuitem', { name: 'Print' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Print' }))
    expect(screen.getByRole('menuitem', { name: 'Invoice' })).toBeInTheDocument()
  })

  it('runs the registered handler with the full MenuActionContext, closing the menu', async () => {
    const handler = vi.fn()
    const onFieldsCommit = vi.fn(async () => null)
    registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler })
    renderMenu({ actions: printMenu, recordId: 'r1', draft: { name: 'Ada' }, onFieldsCommit })

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Print' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Invoice' }))

    await waitFor(() =>
      expect(handler).toHaveBeenCalledWith({
        entity: 'invoice',
        recordId: 'r1',
        draft: { name: 'Ada' },
        setFieldAndCommit: onFieldsCommit,
        relationOps: null,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Invoice' })).not.toBeInTheDocument())
  })

  it('shows an inline error when the handler rejects', async () => {
    registerMenuAction({
      entity: 'invoice',
      name: 'sale.printInvoice',
      handler: () => Promise.reject(new Error('boom')),
    })
    renderMenu({ actions: printMenu, recordId: 'r1' })

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Print' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Invoice' }))

    expect(await screen.findByText('Action failed.')).toBeInTheDocument()
  })

  describe('states.readOnly — parity with HeaderButtonContainer', () => {
    const gatedMenu: MenuNode[] = [
      {
        kind: 'action',
        label: 'Generate',
        action: 'propertymanagement.generateRentReceipt',
        states: { readOnly: { field: 'already_run', op: 'eq', value: true } },
      },
    ]

    it('stays clickable while the condition does not hold', () => {
      registerMenuAction({
        entity: 'invoice',
        name: 'propertymanagement.generateRentReceipt',
        handler: () => undefined,
      })
      renderMenu({ actions: gatedMenu, recordId: 'r1', draft: { already_run: false } })

      fireEvent.click(screen.getByRole('button', { name: 'Options' }))
      expect(screen.getByRole('menuitem', { name: 'Generate' })).toBeEnabled()
    })

    it('renders DISABLED, not hidden, once the condition holds', () => {
      registerMenuAction({
        entity: 'invoice',
        name: 'propertymanagement.generateRentReceipt',
        handler: () => undefined,
      })
      renderMenu({ actions: gatedMenu, recordId: 'r1', draft: { already_run: true } })

      fireEvent.click(screen.getByRole('button', { name: 'Options' }))
      expect(screen.getByRole('menuitem', { name: 'Generate' })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Generate' })).toHaveAttribute('aria-disabled', 'true')
    })
  })

  describe('onDelete — built-in entry, not a declared action', () => {
    it('with no onDelete, no Delete entry appears and the button stays disabled with zero declared actions', () => {
      renderMenu({ actions: [], recordId: 'r1' })
      expect(screen.getByRole('button', { name: 'Options' })).toBeDisabled()
    })

    it('enables the button and shows Delete even with zero declared actions', () => {
      const onDelete = vi.fn()
      renderMenu({ actions: [], recordId: 'r1', onDelete })
      expect(screen.getByRole('button', { name: 'Options' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Options' }))
      expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument()
    })

    it('clicking Delete calls onDelete and closes the menu, alongside declared actions', () => {
      const onDelete = vi.fn()
      registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler: () => undefined })
      renderMenu({ actions: printMenu, recordId: 'r1', onDelete })

      fireEvent.click(screen.getByRole('button', { name: 'Options' }))
      expect(screen.getByRole('menuitem', { name: 'Print' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))

      expect(onDelete).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument()
    })

    it('still disabled on an unsaved record even with onDelete given', () => {
      renderMenu({ actions: [], recordId: 'new', onDelete: vi.fn() })
      expect(screen.getByRole('button', { name: 'Options' })).toBeDisabled()
    })
  })
})
