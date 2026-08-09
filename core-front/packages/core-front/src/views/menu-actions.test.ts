import { afterEach, describe, expect, it } from 'vitest'
import { menuActionRegistry, registerMenuAction, validateMenuActions } from './menu-actions'
import type { MenuNode, ViewDescriptor } from './descriptor'

afterEach(() => {
  menuActionRegistry.clear()
})

function descriptor(actions: MenuNode[]): ViewDescriptor {
  return { entity: 'invoice', viewType: 'form', fields: [], actions }
}

describe('registerMenuAction', () => {
  it('registers a handler retrievable by name', () => {
    registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler: () => undefined })
    expect(menuActionRegistry.get('sale.printInvoice')?.entity).toBe('invoice')
  })

  it('rejects a duplicate name', () => {
    registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler: () => undefined })
    expect(() =>
      registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler: () => undefined }),
    ).toThrowError(/already registered/)
  })
})

describe('validateMenuActions', () => {
  it('is a no-op when actions is omitted', () => {
    expect(() => validateMenuActions({ entity: 'invoice', viewType: 'form', fields: [] })).not.toThrow()
  })

  it('accepts a flat action leaf whose name is registered for the same entity', () => {
    registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler: () => undefined })
    const d = descriptor([{ kind: 'action', label: 'Invoice', action: 'sale.printInvoice' }])
    expect(() => validateMenuActions(d)).not.toThrow()
  })

  it('walks into a submenu to validate its children', () => {
    registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice', handler: () => undefined })
    const d = descriptor([
      {
        kind: 'submenu',
        label: 'Print',
        children: [{ kind: 'action', label: 'Invoice', action: 'sale.printInvoice' }],
      },
    ])
    expect(() => validateMenuActions(d)).not.toThrow()
  })

  it('rejects an unregistered action name', () => {
    const d = descriptor([{ kind: 'action', label: 'Invoice', action: 'sale.printInvoice' }])
    expect(() => validateMenuActions(d)).toThrowError(/not registered/)
  })

  it('rejects an action registered for a different entity', () => {
    registerMenuAction({ entity: 'crm', name: 'crm.export', handler: () => undefined })
    const d = descriptor([{ kind: 'action', label: 'Export', action: 'crm.export' }])
    expect(() => validateMenuActions(d)).toThrowError(/belongs to entity "crm"/)
  })
})
