import { describe, expect, it } from 'vitest'
import sale from './SaleViews'

// The module's contribution is descriptors + route wiring; assert it stays correct.
describe('sale FrontModule', () => {
  it('is named "sale" and exposes the dashboard, list, and form routes', () => {
    expect(sale.name).toBe('sale')
    expect(sale.routes.map((r) => r.path)).toEqual(['/sale', '/sale/list', '/sale/:id'])
  })

  it('wires a dashboard, a tree list, and a form, all over the invoice entity', () => {
    const [dashboard, list, form] = sale.routes
    expect(dashboard.descriptor.viewType).toBe('dashboard')
    expect(list.descriptor.viewType).toBe('tree')
    expect(form.descriptor.viewType).toBe('form')
    expect(sale.routes.every((r) => r.descriptor.entity === 'invoice')).toBe(true)
  })

  it('makes list rows open the invoice form', () => {
    const list = sale.routes.find((r) => r.path === '/sale/list')
    expect(list?.descriptor.formPath).toBe('/sale/:id')
  })

  it('gates the Create button on the write permission — list only, never the dashboard', () => {
    const list = sale.routes.find((r) => r.path === '/sale/list')
    expect(list?.descriptor.createPermission).toBe('sale:invoices:write')

    const dashboard = sale.routes.find((r) => r.path === '/sale')
    expect(dashboard?.descriptor.createPermission).toBeUndefined()
  })

  it('guards every route with sale:invoices:read', () => {
    expect(sale.routes.every((r) => r.permission === 'sale:invoices:read')).toBe(true)
  })

  it('exposes the scalar fields on every view and the relation/detail fields on the form only', () => {
    expect(sale.routes[0].descriptor.fields.map((f) => f.name)).toEqual([
      'number',
      'customer_name',
      'status',
      'issue_date',
      'due_date',
      'total',
    ])
    const formFieldNames = sale.routes[2].descriptor.fields.map((f) => f.name)
    expect(formFieldNames).toContain('customer_id')
    expect(formFieldNames).toContain('logo')
    expect(formFieldNames).toContain('issuer_name')
    expect(formFieldNames).toContain('lines')
    expect(formFieldNames).toContain('payment_terms')
    expect(formFieldNames).toContain('legal_notice')
  })

  it('exposes lines as a read-only, unstored table widget (no editor for it yet)', () => {
    const linesField = sale.routes[2].descriptor.fields.find((f) => f.name === 'lines')
    expect(linesField?.widget).toBe('table')
    expect(linesField?.store).toBe(false)
  })

  it('ships one printable report over the invoice entity', () => {
    expect(sale.reports).toHaveLength(1)
    expect(sale.reports?.[0].name).toBe('sale.invoice')
    expect(sale.reports?.[0].entity).toBe('invoice')
  })

  it('prints the logo as an image node and the line items as a real table node', () => {
    const layout = sale.reports?.[0].layout ?? []
    const masthead = layout.find((n) => n.kind === 'section' && n.className === 'eerp-report-masthead')
    expect(masthead && masthead.kind === 'section' ? masthead.children[0] : null).toEqual({
      kind: 'image',
      source: 'logo',
      className: 'eerp-report-logo',
      alt: 'Company logo',
    })

    const table = layout.find((n) => n.kind === 'table')
    expect(table?.kind === 'table' ? table.source : null).toBe('lines')
    expect(table?.kind === 'table' ? table.columns.map((c) => c.name) : []).toEqual([
      'description',
      'unit',
      'quantity',
      'unit_price',
      'vat_rate',
      'total_ht',
    ])
  })

  it('wires the form options menu with a Print > Invoice action', () => {
    const form = sale.routes.find((r) => r.path === '/sale/:id')
    expect(form?.descriptor.actions).toEqual([
      {
        kind: 'submenu',
        label: 'Print',
        children: [{ kind: 'action', label: 'Invoice', action: 'sale.printInvoice' }],
      },
    ])
  })
})
