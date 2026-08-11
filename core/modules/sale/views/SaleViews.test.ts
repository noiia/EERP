import { describe, expect, it } from 'vitest'
import {
  FORM_NOTEBOOK_ID,
  ModuleRegistry,
  normalizeLayout,
  reportCompanyFallbackFields,
  reportTableRelations,
} from '@eerp/core-front'
import sale from './SaleViews'

// The module's contribution is descriptors + route wiring; assert it stays correct.
describe('sale FrontModule', () => {
  it('is named "sale" and exposes the quote routes ahead of the invoice routes', () => {
    expect(sale.name).toBe('sale')
    expect(sale.routes.map((r) => r.path)).toEqual([
      '/sale',
      '/sale/quote/list',
      '/sale/quote/:id',
      '/sale/quote/lines/:id',
      '/sale/list',
      '/sale/:id',
      '/sale/lines/:id',
    ])
  })

  it('wires a dashboard, a tree list, and a form, all over the invoice entity', () => {
    const dashboard = sale.routes.find((r) => r.path === '/sale')!
    const list = sale.routes.find((r) => r.path === '/sale/list')!
    const form = sale.routes.find((r) => r.path === '/sale/:id')!
    expect(dashboard.descriptor.viewType).toBe('dashboard')
    expect(list.descriptor.viewType).toBe('tree')
    expect(form.descriptor.viewType).toBe('form')
    expect([dashboard, list, form].every((r) => r.descriptor.entity === 'invoice')).toBe(true)
  })

  it('the sale_line route targets the sale_line entity', () => {
    const lineForm = sale.routes.find((r) => r.path === '/sale/lines/:id')
    expect(lineForm?.descriptor.entity).toBe('sale_line')
  })

  it('makes list rows open the invoice form', () => {
    const list = sale.routes.find((r) => r.path === '/sale/list')
    expect(list?.descriptor.formPath).toBe('/sale/:id')
  })

  it('gates the Create button on the write permission — list only, never the dashboard', () => {
    const list = sale.routes.find((r) => r.path === '/sale/list')
    expect(list?.descriptor.createPermission).toBe('invoice:invoice:write')

    const dashboard = sale.routes.find((r) => r.path === '/sale')
    expect(dashboard?.descriptor.createPermission).toBeUndefined()
  })

  it('guards invoice routes with invoice:invoice:read', () => {
    const invoiceRoutes = sale.routes.filter(
      (r) => r.path.startsWith('/sale') && !r.path.startsWith('/sale/quote') && r.path !== '/sale/lines/:id',
    )
    expect(invoiceRoutes.every((r) => r.permission === 'invoice:invoice:read')).toBe(true)
  })

  it('exposes the scalar fields on every view and the relation/detail fields on the form only', () => {
    expect(sale.routes.find((r) => r.path === '/sale')!.descriptor.fields.map((f) => f.name)).toEqual([
      'number',
      'customer_name',
      'status',
      'issue_date',
      'due_date',
      'total',
    ])
    const formFieldNames = sale.routes.find((r) => r.path === '/sale/:id')!.descriptor.fields.map((f) => f.name)
    expect(formFieldNames).toContain('customer_id')
    expect(formFieldNames).toContain('logo')
    expect(formFieldNames).toContain('sale_lines')
    expect(formFieldNames).toContain('payment_terms')
    expect(formFieldNames).toContain('legal_notice')
  })

  it('exposes sale_lines as a real one2many relation over sale_line, scoped by invoice_id', () => {
    const linesField = sale.routes
      .find((r) => r.path === '/sale/:id')!
      .descriptor.fields.find((f) => f.name === 'sale_lines')
    expect(linesField?.type).toBe('relation')
    expect(linesField?.relation).toEqual({
      entity: 'sale_line',
      kind: 'one2many',
      inverseField: 'invoice_id',
      labelField: 'variant_name',
    })
  })

  it('the totals rollups are read-only — computed server-side from sale_line rows', () => {
    const fields = sale.routes.find((r) => r.path === '/sale/:id')!.descriptor.fields
    for (const name of ['subtotal', 'net_subtotal', 'tax_amount', 'total']) {
      const field =
        fields.find((f) => f.name === name) ??
        sale.routes.find((r) => r.path === '/sale')!.descriptor.fields.find((f) => f.name === name)
      expect(field?.readOnly, `${name} should be readOnly`).toBe(true)
    }
    // Discount stays user-editable — it's the one manual input left.
    expect(fields.find((f) => f.name === 'discount')?.readOnly).not.toBe(true)
  })

  it('ships one printable report over the invoice entity', () => {
    expect(sale.reports).toHaveLength(1)
    expect(sale.reports?.[0].name).toBe('sale.invoice')
    expect(sale.reports?.[0].entity).toBe('invoice')
  })

  it('prints the logo as an image node and the line items as a relation-backed table node', () => {
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
      'variant_name',
      'unit',
      'quantity',
      'unit_price',
      'tax_rate',
    ])
  })

  it('resolves the printed line items from sale_line, scoped by invoice_id', () => {
    expect(reportTableRelations(sale.reports![0])).toEqual([
      { source: 'lines', entity: 'sale_line', inverseField: 'invoice_id' },
    ])
  })

  it('falls back the printed issuer block to the active company profile when the invoice\'s own snapshot is blank (multi-company)', () => {
    expect(reportCompanyFallbackFields(sale.reports![0])).toEqual([
      { recordField: 'issuer_name', companyField: 'name' },
      { recordField: 'issuer_address', companyField: 'address' },
      { recordField: 'issuer_phone', companyField: 'phone' },
      { recordField: 'issuer_email', companyField: 'email' },
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

// sale extends its OWN already-registered '/sale/:id' route (same
// self-extension shape core/modules/crm/views/CrmViews.ts uses for its
// Signature page) to move sale_lines off the default two-column body and
// into its own "Order lines" notebook page, first among tabs.
describe('sale — self-extended "Order lines" notebook page (registry-level)', () => {
  function register(): ModuleRegistry {
    const registry = new ModuleRegistry()
    registry.register(sale)
    return registry
  }

  it('order lines lands on its OWN "Order lines" tab, not __form_columns', () => {
    const registry = register()
    const resolved = registry.buildRegistry().get('/sale/:id')!
    const nodes = normalizeLayout(resolved.descriptor)
    const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    expect(notebook).toBeDefined()
    if (notebook && notebook.kind !== 'field') {
      const linesPage = notebook.children.find((p) => p.kind !== 'field' && p.title === 'Order lines')
      expect(linesPage).toBeDefined()
      if (linesPage && linesPage.kind !== 'field') {
        expect(linesPage.children).toEqual([{ kind: 'field', name: 'sale_lines' }])
      }
    }
  })

  it('"Order lines" is the FIRST tab, ahead of the synthesized "Settings" page', () => {
    const registry = register()
    const resolved = registry.buildRegistry().get('/sale/:id')!
    const nodes = normalizeLayout(resolved.descriptor)
    const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    expect(notebook && notebook.kind !== 'field' ? notebook.children.map((p) => p.kind !== 'field' && p.title) : []).toEqual([
      'Order lines',
      'Settings',
    ])
  })

  it('/sale/list and /sale are untouched — the extension targets only :id', () => {
    const registry = register()
    expect(registry.buildRegistry().get('/sale/list')?.descriptor.fields.map((f) => f.name)).not.toContain(
      'sale_lines',
    )
  })
})

// The Quote tile is the FIRST dashboard tile: resolve.ts's dashboardListViews
// rolls a module's tree ('list') routes into tiles in registration order —
// see WarehouseViews.ts's identical doc comment — so this asserts the
// registration order itself, the actual mechanism, not just the route list.
describe('sale — quote registers ahead of invoice (dashboard tile ordering)', () => {
  it('quote/list is the first tree route, invoice/list the second', () => {
    const treeRoutes = sale.routes.filter((r) => r.descriptor.viewType === 'tree')
    expect(treeRoutes.map((r) => r.path)).toEqual(['/sale/quote/list', '/sale/list'])
  })

  it('wires a tree list and a form over the quote entity, plus the quote_line form', () => {
    const list = sale.routes.find((r) => r.path === '/sale/quote/list')!
    const form = sale.routes.find((r) => r.path === '/sale/quote/:id')!
    const lineForm = sale.routes.find((r) => r.path === '/sale/quote/lines/:id')!
    expect(list.descriptor.viewType).toBe('tree')
    expect(form.descriptor.viewType).toBe('form')
    expect(list.descriptor.entity).toBe('quote')
    expect(form.descriptor.entity).toBe('quote')
    expect(lineForm.descriptor.entity).toBe('quote_line')
    expect(list.descriptor.formPath).toBe('/sale/quote/:id')
    expect(list.descriptor.createPermission).toBe('quote:quote:write')
  })

  it('exposes quote_lines as a real one2many relation over quote_line, scoped by quote_id', () => {
    const linesField = sale.routes
      .find((r) => r.path === '/sale/quote/:id')!
      .descriptor.fields.find((f) => f.name === 'quote_lines')
    expect(linesField?.type).toBe('relation')
    expect(linesField?.relation).toEqual({
      entity: 'quote_line',
      kind: 'one2many',
      inverseField: 'quote_id',
      labelField: 'variant_name',
    })
  })
})

// Same self-extension shape as invoice's "Order lines" page above, targeting
// quote's own form route instead.
describe('sale — self-extended "Quote lines" notebook page (registry-level)', () => {
  function register(): ModuleRegistry {
    const registry = new ModuleRegistry()
    registry.register(sale)
    return registry
  }

  it('"Quote lines" is the FIRST tab, ahead of the synthesized "Settings" page', () => {
    const registry = register()
    const resolved = registry.buildRegistry().get('/sale/quote/:id')!
    const nodes = normalizeLayout(resolved.descriptor)
    const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    expect(notebook && notebook.kind !== 'field' ? notebook.children.map((p) => p.kind !== 'field' && p.title) : []).toEqual([
      'Quote lines',
      'Settings',
    ])
  })

  it('/sale/quote/list is untouched — the extension targets only /sale/quote/:id', () => {
    const registry = register()
    expect(registry.buildRegistry().get('/sale/quote/list')?.descriptor.fields.map((f) => f.name)).not.toContain(
      'quote_lines',
    )
  })
})
