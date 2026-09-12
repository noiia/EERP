import {
  createAttachmentClient,
  fetchReportPDF,
  FORM_NOTEBOOK_ID,
  registerHeaderButtonAction,
  useEntityRefreshStore,
  type FrontRoute,
  type HeaderButtonDescriptor,
  type Operation,
  type ViewDescriptor,
} from '@eerp/core-front'

// property_management — the Property record itself. See
// core/modules/propertymanagement/module.go's doc comments for the full
// data model across this module's six entities. `entity` names are the Go
// route prefix from module.go's orm.Register calls, not the module slug
// 'propertymanagement'.

/** The Property record as served by Go's /property_management endpoints. */
export interface PropertyManagement {
  id: string
  name: string
  address_number?: number | null
  address_complement?: string
  address_street?: string
  address_zip_code?: string
  address_city?: string
  address_state?: string
  address_country?: string
  floor_area?: number
  /** The mortgage/loan this property carries — a plain editable figure, not
   * derived from anything else. */
  loan_amount?: number
  /** The apartment's own monthly rent — a plain editable figure. Not itself
   * a billing line: the Billing lines page (below) is where the user
   * actually enters a priced "Apartment" line, typically at this figure,
   * alongside whatever other lines the month's receipt needs. */
  rent_price?: number
  /** "2026-08"-shaped, null until the first Generate — set by the Generate
   * Rent Receipt header button. */
  last_receipt_month?: string | null
  /** Server-computed, non-stored (GetProperty override, handler.go) — never
   * a real column, never sent back on write. */
  receipt_generated_this_month?: boolean
}

/**
 * The property's full postal address as one printable line — "12 Main
 * Street, Apt 4B, 75001 Paris, France" — from the type: 'address' composite
 * field's 7 sibling draft columns (core-front/CLAUDE.md's AddressWidget).
 * Was just `[address_number, address_street].join(' ')`, silently dropping
 * complement/zip code/city/state/country — the reason a generated receipt's
 * report read "barely empty".
 */
function formatPropertyAddress(draft: Record<string, unknown>): string {
  const line = (...parts: unknown[]) =>
    parts
      .filter((part) => part != null && part !== '')
      .map(String)
      .join(' ')
  return [
    line(draft.address_number, draft.address_street),
    line(draft.address_complement),
    line(draft.address_zip_code, draft.address_city),
    line(draft.address_state),
    line(draft.address_country),
  ]
    .filter((part) => part !== '')
    .join(', ')
}

// Generate Rent Receipt: creates one PARENT row for this property+period
// (the summary the property form's own rent_receipts field lists — see
// module.go's doc comment on PropertyManagementRentReceipt) plus one
// dedicated CHILD row per CURRENT tenant, each rendered to its OWN PDF via
// the propertymanagement.rentReceipt report (reports/rent_receipt_report.ts)
// and re-uploaded as that child's fixed snapshot (never re-rendered on a
// later download — the user's own explicit requirement) — a tenant moving
// out/in later never changes what an already-generated receipt shows.
// Mirrors modules/sale/views/quote_views.ts's sale.acceptQuote shape (read
// via relationOps, create, then setFieldAndCommit).
registerHeaderButtonAction({
  entity: 'property_management',
  name: 'propertymanagement.generateRentReceipt',
  handler: async (ctx) => {
    const ops = ctx.relationOps
    if (!ops) return

    const period = new Date().toISOString().slice(0, 7)
    const generatedAt = new Date().toISOString()
    const addressLine = formatPropertyAddress(ctx.draft)

    // Snapshot the property's own billing lines (property_management_
    // billing_line_views.ts) the same way property_name/address/floor_area
    // are already snapshotted below — a receipt must keep reading correctly
    // even if the lines change later. subtotal/tax_amount/total below are
    // just a SUM of each line's own `subtotal`/`total` — already fully
    // computed server-side (handler.go's computeBillingLineTotal, covering
    // tax_rate, every tagged sale_tax, AND the workspace's tax.price_mode
    // setting), never re-derived here. `subtotal` (not `unit_price`) is what
    // sums correctly regardless of that setting — once prices can be
    // tax-inclusive, unit_price alone no longer tells you the tax-excluded
    // figure. This is only an upfront estimate for the parent/child rows
    // created below — each property_management_rent_receipt_line create
    // that follows triggers its own backend recompute of these same three
    // columns (handler.go's CreateRentReceiptLine/recomputeReceiptTotals),
    // which is what actually double-checks them before the PDF is
    // generated.
    const billingLines = await ops.list('property_management_billing_line', {
      filter: { property_management_id: ctx.recordId },
      pageSize: 100,
    })
    const total = billingLines.reduce((sum, l) => sum + Number(l.total ?? 0), 0)
    const subtotal = billingLines.reduce((sum, l) => sum + Number(l.subtotal ?? 0), 0)
    const taxAmount = total - subtotal

    const links = await ops.list('property_management_tenant', {
      filter: { property_management_id: ctx.recordId },
      pageSize: 100,
    })
    const tenants = await Promise.all(
      links.map((link) =>
        typeof link.contact_id === 'string' ? ops.get('contact', link.contact_id).catch(() => null) : null,
      ),
    )
    const tenantNames = tenants
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => String(c.name ?? ''))

    const parent = await ops.create('property_management_rent_receipt', {
      property_management_id: ctx.recordId,
      is_parent: true,
      period,
      generated_at: generatedAt,
      property_name: ctx.draft.name,
      property_address: addressLine,
      floor_area: ctx.draft.floor_area,
      rent_price: ctx.draft.rent_price,
      subtotal,
      tax_amount: taxAmount,
      total,
      tenant_names: tenantNames.join(', '),
      // receipt_file is a plain NOT NULL bool column (module.go) — must be
      // present on Create even though BooleanFileWidget/CarouselSlide never
      // trust the stored flag anyway (they re-derive "does a file exist"
      // live via the attachment service). The parent never gets a PDF.
      receipt_file: false,
    })

    // One dedicated child per tenant — independent creates/uploads, so one
    // tenant's failure (e.g. a mid-batch attachments hiccup) never blocks
    // the others.
    for (const name of tenantNames) {
      const child = await ops.create('property_management_rent_receipt', {
        parent_id: parent.id,
        is_parent: false,
        period,
        generated_at: generatedAt,
        property_name: ctx.draft.name,
        property_address: addressLine,
        floor_area: ctx.draft.floor_area,
        rent_price: ctx.draft.rent_price,
        subtotal,
        tax_amount: taxAmount,
        total,
        tenant_names: name,
        receipt_file: false,
      })

      // Copy the same billing lines onto this child (report-table's own
      // source, rent_receipt_report.ts) — every tenant's receipt shows the
      // property's full billing-lines table, same as the parent summary.
      for (const line of billingLines) {
        await ops.create('property_management_rent_receipt_line', {
          rent_receipt_id: child.id,
          name: line.name,
          unit_price: line.unit_price,
          tax_rate: line.tax_rate,
          subtotal: line.subtotal,
          total: line.total,
        })
      }

      // Best-effort: the receipt row is the workflow's real state — a PDF
      // failure (e.g. attachments' S3 store not configured in this
      // deployment, internal/attachments' own degrade posture) must not
      // block the other tenants' receipts or leave the property stuck
      // unable to re-attempt this month.
      try {
        const pdf = await fetchReportPDF('propertymanagement.rentReceipt', child.id)
        await createAttachmentClient().upload(
          { table: 'property_management_rent_receipt', recordId: child.id, field: 'receipt_file' },
          pdf,
          `rent-receipt-${period}-${name}.pdf`,
        )
      } catch {
        // Swallowed — see the comment above.
      }
    }

    // The property form's own rent_receipts RelationListWidget (and the
    // parent's own children widget, once open) have no way to know these
    // rows exist (created via relationOps, not their own create wizard) —
    // bump once so any mounted widget over this entity re-fetches.
    useEntityRefreshStore.getState().bump('property_management_rent_receipt')

    await ctx.setFieldAndCommit({ last_receipt_month: period })
  },
})

const propertyHeaderButtons: HeaderButtonDescriptor[] = [
  {
    name: 'propertymanagement.generateRentReceipt',
    label: 'Generate Rent Receipt',
    // Stays VISIBLE but DISABLED once already run this month — a server-
    // computed key (see PropertyManagement.receipt_generated_this_month
    // above), never a stored column, so this Condition needs no dynamic
    // "now" operator.
    states: { readOnly: { field: 'receipt_generated_this_month', op: 'eq', value: true } },
  },
]

export const fields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'address', label: 'Address', type: 'address', widget: 'form' },
  { name: 'floor_area', label: 'Floor area', type: 'number', widget: 'float' },
  { name: 'loan_amount', label: 'Loan amount', type: 'number', widget: 'monetary' },
  { name: 'rent_price', label: 'Rent price', type: 'number', widget: 'monetary' },
]

// Form-only: current_tenant (many2many, tags widget) stays in the default
// two-column body — compact, unlike the three bulkier one2many tables below,
// which propertyExtendOperations moves into their own notebook pages.
// widgetOptions.deferred (the user's own explicit choice): a tenant change
// stages in the draft and marks the form dirty — Save is what actually
// writes the property_management_tenant junction rows — rather than every
// other many2many field's default "junction row written the instant you
// click," so an accidental tenant edit stays discardable via Reset like any
// other field, and "did I save?" has one answer: the Save button's own
// dirty state.
const formFields: ViewDescriptor['fields'] = [
  ...fields,
  {
    name: 'current_tenant',
    label: 'Current tenant(s)',
    type: 'relation',
    relation: {
      entity: 'contact',
      kind: 'many2many',
      via: 'property_management_tenant',
      viaFields: { own: 'property_management_id', related: 'contact_id' },
      labelField: 'name',
    },
    widgetOptions: { deferred: true },
  },
  {
    name: 'photos',
    label: 'Photos',
    type: 'relation',
    widget: 'carousel',
    widgetOptions: { max: 20 },
    relation: { entity: 'property_management_photo', kind: 'one2many', inverseField: 'property_management_id' },
  },
  {
    name: 'equipment',
    label: 'Equipment',
    type: 'relation',
    relation: {
      entity: 'property_management_equipment',
      kind: 'one2many',
      inverseField: 'property_management_id',
      labelField: 'name',
      formPath: '/propertymanagement/equipment/:id',
    },
  },
  {
    name: 'rent_receipts',
    label: 'Rent receipts',
    type: 'relation',
    readOnly: true,
    // widgetOptions.reverse: the most recently generated receipt (the last
    // one created) shows first, instead of the oldest.
    widgetOptions: { reverse: true },
    relation: {
      entity: 'property_management_rent_receipt',
      kind: 'one2many',
      inverseField: 'property_management_id',
      labelField: 'period',
      formPath: '/propertymanagement/receipts/:id',
    },
  },
  // The line items a rent receipt is actually built from (the apartment's
  // own rent, condominium fees, an accrual for expenses, ...) — real child
  // rows (property_management_billing_line), not a JSONB blob, creatable
  // straight from this embedded grid via the engine's usual one2many
  // "Create a new..." wizard (property_management_billing_line_views.ts's
  // own descriptor is what the wizard renders).
  {
    name: 'billing_lines',
    label: 'Billing lines',
    type: 'relation',
    relation: {
      entity: 'property_management_billing_line',
      kind: 'one2many',
      inverseField: 'property_management_id',
      labelField: 'name',
      formPath: '/propertymanagement/billing-lines/:id',
    },
  },
  // The same HT -> tax-by-rate -> TTC recap component sale's own
  // sale_totals/quote_totals fields use (widgets.tsx's TaxTotalsWidget) —
  // computes itself, live, from the SAME billing_lines above. store: false —
  // nothing here round-trips to the server. Billing lines have no quantity
  // column (a line is priced as a whole, not quantity × unit_price) —
  // TaxTotalsWidget treats an absent quantity as 1, the identity, rather
  // than zeroing every line out (see its own doc comment).
  {
    name: 'billing_totals',
    label: 'Totals',
    type: 'totals',
    hideLabel: true,
    store: false,
    relation: { entity: 'property_management_billing_line', kind: 'one2many', inverseField: 'property_management_id' },
  },
]

const dashboardView: ViewDescriptor = {
  entity: 'property_management',
  viewType: 'dashboard',
  fields,
  permissions: ['property_management:property_management:read'],
}

const listView: ViewDescriptor = {
  entity: 'property_management',
  viewType: 'tree',
  fields,
  formPath: '/propertymanagement/:id',
  createPermission: 'property_management:property_management:write',
  permissions: ['property_management:property_management:read'],
}

const formView: ViewDescriptor = {
  entity: 'property_management',
  viewType: 'form',
  fields: formFields,
  permissions: ['property_management:property_management:read'],
  headerButtons: propertyHeaderButtons,
}

// Moves photos/equipment/rent_receipts off the default two-column body into
// their own notebook pages — same self-extension shape
// core/modules/sale/views/invoice_views.ts's orderLinesPageOperations uses.
export const propertyExtendOperations: Operation[] = [
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Photos', children: [{ kind: 'field', name: 'photos' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Equipment', children: [{ kind: 'field', name: 'equipment' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Rent receipt', children: [{ kind: 'field', name: 'rent_receipts' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
  // Added LAST (still position: 'first') so Billing lines lands as the very
  // FIRST tab, ahead of Rent receipt — the form's whole purpose is
  // generating a receipt off these lines, so they're what a user should
  // land on.
  {
    op: 'addNode',
    node: {
      kind: 'page',
      title: 'Billing lines',
      children: [{ kind: 'field', name: 'billing_lines' }, { kind: 'field', name: 'billing_totals' }],
    },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
]

// dashboardRoute MUST be first in propertymanagement_views.ts's assembled
// FrontModule — Menu.tsx's landing tile links to module.routes[0].path.
export const dashboardRoute: FrontRoute = {
  path: '/propertymanagement',
  descriptor: dashboardView,
  permission: 'property_management:property_management:read',
}

export const propertyRoutes: FrontRoute[] = [
  { path: '/propertymanagement/list', descriptor: listView, permission: 'property_management:property_management:read' },
  { path: '/propertymanagement/:id', descriptor: formView, permission: 'property_management:property_management:read' },
]
