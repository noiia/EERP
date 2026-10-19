import { describe, expect, it, vi } from 'vitest'
import {
  FORM_NOTEBOOK_ID,
  ModuleRegistry,
  headerButtonRegistry,
  headerMenuRegistry,
  normalizeLayout,
  DEFAULT_REPORT_NAME,
  reportCompanyFallbackFields,
  reportImageSources,
  reportTableRelations,
  type HeaderButtonContext,
} from '@eerp/core-front'
import sale from './sale_views'
import warehouse from '../../warehouse/views/warehouse_views'

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
      '/sale/taxes',
      '/sale/taxes/:id',
    ])
  })

  it('hides the tax catalog from the top bar\'s auto-generated buttons, since it lives in Configuration instead', () => {
    const taxes = sale.routes.find((r) => r.path === '/sale/taxes')!
    expect(taxes.descriptor.hideFromTopBar).toBe(true)
  })

  it('registers a Taxes line in sale\'s own Configuration header menu', () => {
    const configuration = headerMenuRegistry.forModule('sale').find((m) => m.name === 'configuration')
    expect(configuration?.entries).toContainEqual({
      kind: 'line',
      label: 'Taxes',
      path: '/sale/taxes',
      permission: 'sale_tax:sale_tax:read',
    })
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
      (r) =>
        r.path.startsWith('/sale') &&
        !r.path.startsWith('/sale/quote') &&
        r.path !== '/sale/lines/:id' &&
        !r.path.startsWith('/sale/taxes'),
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

  it.each([
    ['invoice', '/sale/:id'],
    ['quote', '/sale/quote/:id'],
  ])(
    '%s: customer_id is the required, primary Customer many2one, auto-filling the customer_name/email snapshot on pick',
    (_entity, path) => {
      const fields = sale.routes.find((r) => r.path === path)!.descriptor.fields
      const customerId = fields.find((f) => f.name === 'customer_id')
      expect(customerId).toMatchObject({
        label: 'Customer',
        type: 'relation',
        required: true,
        relation: { entity: 'contact', kind: 'many2one', labelField: 'name' },
      })
      expect(customerId?.widgetOptions).toEqual({
        fillFields: { name: 'customer_name', email: 'customer_email' },
      })
      // The bill-to snapshot itself is relabeled so it reads as distinct
      // from customer_id's own "Customer" — still required (a customer with
      // no linked contact still needs SOME printed name).
      const customerName = fields.find((f) => f.name === 'customer_name')
      expect(customerName).toMatchObject({ label: 'Customer name', type: 'text', required: true })
    },
  )

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

  it('total stays read-only where it is still shown (dashboard/list)', () => {
    const total = sale.routes.find((r) => r.path === '/sale')!.descriptor.fields.find((f) => f.name === 'total')
    expect(total?.readOnly).toBe(true)
  })

  it('no bare subtotal/discount/net_subtotal/tax_amount/currency fields on the form — the totals recap replaces them', () => {
    const fields = sale.routes.find((r) => r.path === '/sale/:id')!.descriptor.fields
    for (const name of ['subtotal', 'discount', 'net_subtotal', 'tax_amount', 'currency']) {
      expect(fields.find((f) => f.name === name), `${name} should not be a field`).toBeUndefined()
    }
  })

  it('the sale_totals recap computes from sale_lines, store: false', () => {
    const fields = sale.routes.find((r) => r.path === '/sale/:id')!.descriptor.fields
    const totals = fields.find((f) => f.name === 'sale_totals')
    expect(totals?.type).toBe('totals')
    expect(totals?.store).toBe(false)
    expect(totals?.relation).toEqual({ entity: 'sale_line', kind: 'one2many', inverseField: 'invoice_id' })
  })

  it('ships one printable report over the invoice entity, and one over the quote entity', () => {
    expect(sale.reports).toHaveLength(2)
    expect(sale.reports?.[0].name).toBe('sale.invoice')
    expect(sale.reports?.[0].entity).toBe('invoice')
    expect(sale.reports?.[1].name).toBe('sale.quote')
    expect(sale.reports?.[1].entity).toBe('quote')
  })

  it('prints the line items as a relation-backed table node', () => {
    const layout = sale.reports?.[0].layout ?? []
    const table = layout.find((n) => n.kind === 'table')
    expect(table?.kind === 'table' ? table.source : null).toBe('lines')
    expect(table?.kind === 'table' ? table.columns.map((c) => c.name) : []).toEqual([
      'variant_name',
      'quantity',
      'unit_price',
      'tax_rate',
      'total',
    ])
  })

  it('resolves the printed line items from sale_line, scoped by invoice_id', () => {
    expect(reportTableRelations(sale.reports![0])).toEqual([
      { source: 'lines', entity: 'sale_line', inverseField: 'invoice_id' },
    ])
  })

  it('prints no issuer block of its own: the letterhead header shows the company', () => {
    expect(reportCompanyFallbackFields(sale.reports![0])).toEqual([])
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
// self-extension shape core/modules/crm/views/crm_views.ts uses for its
// Signature page) to move sale_lines off the default two-column body and
// into its own "Order lines" notebook page, first among tabs.
describe('sale — self-extended "Order lines" notebook page (registry-level)', () => {
  function register(): ModuleRegistry {
    const registry = new ModuleRegistry()
    registry.register(warehouse)
    registry.register(sale, { depends: ['warehouse'] })
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
        expect(linesPage.children).toEqual([
          { kind: 'field', name: 'sale_lines' },
          { kind: 'field', name: 'sale_totals' },
        ])
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
// see warehouse_views.ts's identical doc comment — so this asserts the
// registration order itself, the actual mechanism, not just the route list.
describe('sale — quote registers ahead of invoice (dashboard tile ordering)', () => {
  it('quote/list is the first tree route, invoice/list the second', () => {
    const treeRoutes = sale.routes.filter((r) => r.descriptor.viewType === 'tree')
    expect(treeRoutes.map((r) => r.path)).toEqual(['/sale/quote/list', '/sale/list', '/sale/taxes'])
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
    registry.register(warehouse)
    registry.register(sale, { depends: ['warehouse'] })
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

describe('sale — quote workflow (header buttons)', () => {
  it('status options run draft -> confirmed -> sent -> accepted/declined, plus expired', () => {
    const status = sale.routes
      .find((r) => r.path === '/sale/quote/:id')!
      .descriptor.fields.find((f) => f.name === 'status')
    expect(status?.selection?.options).toEqual(['draft', 'confirmed', 'sent', 'accepted', 'declined', 'expired'])
  })

  it('declares Confirm/Send/Accept as primary buttons and Decline as secondary, each gated on status', () => {
    const headerButtons = sale.routes.find((r) => r.path === '/sale/quote/:id')!.descriptor.headerButtons
    expect(headerButtons).toEqual([
      {
        name: 'sale.confirmQuote',
        label: 'Confirm',
        states: { visible: { field: 'status', op: 'eq', value: 'draft' } },
      },
      {
        name: 'sale.sendQuote',
        label: 'Send',
        states: { visible: { field: 'status', op: 'eq', value: 'confirmed' } },
      },
      {
        name: 'sale.acceptQuote',
        label: 'Accept',
        states: { visible: { field: 'status', op: 'eq', value: 'sent' } },
      },
      {
        name: 'sale.declineQuote',
        label: 'Decline',
        variant: 'secondary',
        states: { visible: { field: 'status', op: 'eq', value: 'sent' } },
      },
    ])
  })

  function context(overrides: Partial<HeaderButtonContext> = {}): HeaderButtonContext {
    return {
      entity: 'quote',
      recordId: 'q1',
      draft: { number: 'Q-2026-0001' },
      setFieldAndCommit: vi.fn(async (patch) => ({ id: 'q1', ...patch })),
      relationOps: null,
      runAction: vi.fn(async () => ({ record: { id: 'q1' } })),
      navigate: vi.fn(),
      ...overrides,
    }
  }

  it.each([
    ['sale.confirmQuote', 'confirm'],
    ['sale.sendQuote', 'send'],
  ])('%s runs the server-side %s step, nothing client-side', async (name, action) => {
    const ctx = context()
    await headerButtonRegistry.get(name)!.handler(ctx)
    expect(ctx.runAction).toHaveBeenCalledWith(action, { revalidate: undefined })
    expect(ctx.setFieldAndCommit).not.toHaveBeenCalled()
  })

  it('sale.declineQuote sets status to declined', async () => {
    const ctx = context()
    await headerButtonRegistry.get('sale.declineQuote')!.handler(ctx)
    expect(ctx.setFieldAndCommit).toHaveBeenCalledWith({ status: 'declined' })
  })

  it('sale.acceptQuote converts server-side, then opens the new invoice', async () => {
    const ctx = context({ runAction: vi.fn(async () => ({ record: { id: 'q1' }, invoice_id: 'inv1' })) })
    await headerButtonRegistry.get('sale.acceptQuote')!.handler(ctx)
    expect(ctx.runAction).toHaveBeenCalledWith('accept', { revalidate: ['invoice', 'sale_line', 'invoice_recipient'] })
    expect(ctx.navigate).toHaveBeenCalledWith('/sale/inv1')
  })

  it('fails loudly where the host binds no record actions', async () => {
    const ctx = context({ runAction: undefined })
    await expect(headerButtonRegistry.get('sale.confirmQuote')!.handler(ctx)).rejects.toThrow()
  })
})

describe('sale — invoice workflow (header buttons)', () => {
  const invoiceForm = () => sale.routes.find((r) => r.path === '/sale/:id')!.descriptor

  it('adds a confirmed step between draft and sent', () => {
    const status = invoiceForm().fields.find((f) => f.name === 'status')
    expect(status?.selection?.options).toEqual(['draft', 'confirmed', 'sent', 'paid', 'overdue', 'cancelled'])
  })

  it('shows Confirm on a draft and Send once confirmed, both server-side steps', async () => {
    expect(invoiceForm().headerButtons?.map((b) => [b.name, b.states?.visible])).toEqual([
      ['sale.confirmInvoice', { field: 'status', op: 'eq', value: 'draft' }],
      ['sale.sendInvoice', { field: 'status', op: 'eq', value: 'confirmed' }],
    ])
    for (const [name, action] of [['sale.confirmInvoice', 'confirm'], ['sale.sendInvoice', 'send']]) {
      const runAction = vi.fn(async () => ({}))
      await headerButtonRegistry.get(name)!.handler({
        entity: 'invoice', recordId: 'i1', draft: {}, setFieldAndCommit: vi.fn(), relationOps: null, runAction,
      })
      expect(runAction).toHaveBeenCalledWith(action)
    }
  })
})

describe('sale — numbers and recipients', () => {
  const form = (path: string) => sale.routes.find((r) => r.path === path)!.descriptor

  it.each(['/sale/:id', '/sale/quote/:id'])('%s: the number is read-only (Go assigns it), never required', (path) => {
    expect(form(path).fields.find((f) => f.name === 'number')).toMatchObject({ readOnly: true })
    expect(form(path).fields.find((f) => f.name === 'number')?.required).toBeUndefined()
  })

  it('the quote has no reference field any more; the invoice keeps its own', () => {
    expect(form('/sale/quote/:id').fields.some((f) => f.name === 'reference')).toBe(false)
    expect(form('/sale/:id').fields.some((f) => f.name === 'reference')).toBe(true)
  })

  it.each([
    ['/sale/quote/:id', 'quote_recipient', 'quote_id'],
    ['/sale/:id', 'invoice_recipient', 'invoice_id'],
  ])('%s has a Recipients many2many over %s', (path, via, own) => {
    expect(form(path).fields.find((f) => f.name === 'recipients')?.relation).toEqual({
      entity: 'contact',
      kind: 'many2many',
      via,
      viaFields: { own, related: 'contact_id' },
      labelField: 'name',
    })
  })
})

describe('sale — invoice.quote_id (provenance link)', () => {
  it('is a read-only many2one to quote, labeled by number', () => {
    const field = sale.routes
      .find((r) => r.path === '/sale/:id')!
      .descriptor.fields.find((f) => f.name === 'quote_id')
    expect(field?.type).toBe('relation')
    expect(field?.readOnly).toBe(true)
    expect(field?.relation).toEqual({ entity: 'quote', kind: 'many2one', labelField: 'number' })
  })
})

describe('sale — quote and invoice reports', () => {
  const registry = () => new ModuleRegistry().register(warehouse).register(sale, { depends: ['warehouse'] })
  const report = (name: string) => registry().buildReportRegistry().get(name)!

  it.each(['sale.quote', 'sale.invoice'])('%s extends the default report: letterhead header + footer', (name) => {
    expect(sale.reports?.find((r) => r.name === name)?.extends).toBe(DEFAULT_REPORT_NAME)
    expect(report(name).chrome).toEqual({ header: true, footer: true })
  })

  it.each(['sale.quote', 'sale.invoice'])(
    '%s prints the Customer in the rent receipt\'s address block, no own logo or issuer block',
    (name) => {
      const layout = report(name).layout
      const customer = layout.find((n) => n.kind === 'section' && n.className === 'eerp-report-address')
      expect(customer && customer.kind === 'section' ? customer.children[0] : null).toEqual({
        kind: 'text',
        text: 'Customer:',
        className: 'eerp-report-label',
      })
      expect(reportImageSources(report(name))).toEqual([])
      expect(JSON.stringify(layout)).not.toContain('issuer_')
    },
  )

  it('the quote lists quote_line rows and "Valid until", the invoice sale_line rows and "Due date"', () => {
    expect(reportTableRelations(report('sale.quote'))).toEqual([{ source: 'lines', entity: 'quote_line', inverseField: 'quote_id' }])
    expect(reportTableRelations(report('sale.invoice'))).toEqual([{ source: 'lines', entity: 'sale_line', inverseField: 'invoice_id' }])
    expect(JSON.stringify(report('sale.quote').layout)).toContain('Valid until:')
    expect(JSON.stringify(report('sale.invoice').layout)).toContain('Due date:')
    // The quote has no reference any more; the invoice keeps its own.
    expect(JSON.stringify(report('sale.quote').layout)).not.toContain('"reference"')
    expect(JSON.stringify(report('sale.invoice').layout)).toContain('"reference"')
  })
})

describe('sale — product Taxes (extends the warehouse product form)', () => {
  it('adds a Taxes many2many over product_tax next to the price', () => {
    const registry = new ModuleRegistry().register(warehouse).register(sale, { depends: ['warehouse'] })
    const form = registry.buildRegistry().get('/warehouse/products/:id')!.descriptor
    expect(form.fields.find((f) => f.name === 'taxes')?.relation).toEqual({
      entity: 'sale_tax',
      kind: 'many2many',
      via: 'product_tax',
      viaFields: { own: 'product_id', related: 'sale_tax_id' },
      labelField: 'name',
    })
    const columns = normalizeLayout(form).find((n) => n.kind !== 'field' && n.id === '__form_columns')
    const names = columns && columns.kind !== 'field' ? columns.children.map((c) => (c.kind === 'field' ? c.name : c.kind)) : []
    expect(names).toEqual(['reference', 'unit_price', 'taxes'])
  })
})
