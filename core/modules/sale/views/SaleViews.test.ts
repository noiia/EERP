import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FORM_NOTEBOOK_ID,
  ModuleRegistry,
  headerButtonRegistry,
  normalizeLayout,
  reportCompanyFallbackFields,
  reportTableRelations,
  type HeaderButtonContext,
  type RelationOps,
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
    // issuer_address_number carries no fallback (see reportPartyAddressFields'
    // own doc comment: a NUMBER field can't distinguish "blank" from a real 0
    // the way company[companyField] ?? '' does for strings).
    expect(reportCompanyFallbackFields(sale.reports![0])).toEqual([
      { recordField: 'issuer_name', companyField: 'name' },
      { recordField: 'issuer_address_street', companyField: 'address_street' },
      { recordField: 'issuer_address_complement', companyField: 'address_complement' },
      { recordField: 'issuer_address_zip_code', companyField: 'address_zip_code' },
      { recordField: 'issuer_address_city', companyField: 'address_city' },
      { recordField: 'issuer_address_country', companyField: 'address_country' },
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
      draft: { number: 'QUO-0001' },
      setFieldAndCommit: vi.fn(async (patch) => ({ id: 'q1', ...patch })),
      relationOps: null,
      ...overrides,
    }
  }

  it('sale.confirmQuote sets status to confirmed', async () => {
    const ctx = context()
    await headerButtonRegistry.get('sale.confirmQuote')!.handler(ctx)
    expect(ctx.setFieldAndCommit).toHaveBeenCalledWith({ status: 'confirmed' })
  })

  it('sale.declineQuote sets status to declined', async () => {
    const ctx = context()
    await headerButtonRegistry.get('sale.declineQuote')!.handler(ctx)
    expect(ctx.setFieldAndCommit).toHaveBeenCalledWith({ status: 'declined' })
  })

  describe('sale.sendQuote', () => {
    afterEach(() => vi.restoreAllMocks())

    it('advances status to sent, then prints the quote report', async () => {
      // Sale's own tsconfig has no DOM lib (views/descriptors are plain TS,
      // no browser APIs at compile time) — a plain ok/json stub matches what
      // exportReportPDF actually reads, without needing the real Response type.
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ download_url: '/api/reports/pdf?key=x' }) }))
      vi.stubGlobal('fetch', fetchMock)
      // This module's tests run under Node, not jsdom — window doesn't exist
      // at all until stubbed (exportReportPDF calls window.open directly).
      vi.stubGlobal('window', { open: vi.fn() })
      const ctx = context()

      await headerButtonRegistry.get('sale.sendQuote')!.handler(ctx)

      expect(ctx.setFieldAndCommit).toHaveBeenCalledWith({ status: 'sent' })
      expect(fetchMock).toHaveBeenCalledWith('/api/reports/sale.quote/q1', { method: 'POST' })
    })
  })

  describe('sale.acceptQuote', () => {
    it('does nothing without a wired RelationOpsProvider', async () => {
      const ctx = context({ relationOps: null })
      await headerButtonRegistry.get('sale.acceptQuote')!.handler(ctx)
      expect(ctx.setFieldAndCommit).not.toHaveBeenCalled()
    })

    it('creates an invoice snapshotting the quote, one sale_line per quote_line, links quote_id, then marks accepted', async () => {
      const quoteLines = [
        { id: 'ql1', quote_id: 'q1', variant_id: 'v1', quantity: 2 },
        { id: 'ql2', quote_id: 'q1', variant_id: 'v2', quantity: 1 },
      ]
      const ops: RelationOps = {
        list: vi.fn(async () => quoteLines),
        get: vi.fn(),
        create: vi.fn(async (entity: string, body: Record<string, unknown>) => ({
          id: entity === 'invoice' ? 'inv1' : 'sl-new',
          ...body,
        })),
        remove: vi.fn(),
      }
      const ctx = context({
        draft: {
          number: 'QUO-0001',
          customer_name: 'Acme',
          customer_id: 'c1',
          subject: 'Consulting',
        },
        relationOps: ops,
      })

      await headerButtonRegistry.get('sale.acceptQuote')!.handler(ctx)

      expect(ops.list).toHaveBeenCalledWith('quote_line', { filter: { quote_id: 'q1' }, pageSize: 200 })
      expect(ops.create).toHaveBeenCalledWith(
        'invoice',
        expect.objectContaining({
          number: 'INV-QUO-0001',
          customer_name: 'Acme',
          customer_id: 'c1',
          subject: 'Consulting',
          status: 'draft',
          quote_id: 'q1',
        }),
      )
      expect(ops.create).toHaveBeenCalledWith('sale_line', { invoice_id: 'inv1', variant_id: 'v1', quantity: 2 })
      expect(ops.create).toHaveBeenCalledWith('sale_line', { invoice_id: 'inv1', variant_id: 'v2', quantity: 1 })
      expect(ctx.setFieldAndCommit).toHaveBeenCalledWith({ status: 'accepted' })
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

describe('sale — quote.quote report', () => {
  it('prints the logo, the quote_line table, and a "Valid until" date instead of "Due date"', () => {
    const report = sale.reports?.find((r) => r.name === 'sale.quote')!
    const masthead = report.layout.find((n) => n.kind === 'section' && n.className === 'eerp-report-masthead')
    expect(masthead && masthead.kind === 'section' ? masthead.children[0] : null).toEqual({
      kind: 'image',
      source: 'logo',
      className: 'eerp-report-logo',
      alt: 'Company logo',
    })
    expect(reportTableRelations(report)).toEqual([{ source: 'lines', entity: 'quote_line', inverseField: 'quote_id' }])
    const validUntil = report.layout.find(
      (n) => n.kind === 'section' && n.children.some((c) => c.kind === 'text' && c.text === 'Valid until:'),
    )
    expect(validUntil).toBeDefined()
  })
})
