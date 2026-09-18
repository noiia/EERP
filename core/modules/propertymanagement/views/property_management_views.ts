import {
  createAttachmentClient,
  fetchReportPDF,
  FORM_COLUMNS_ID,
  FORM_NOTEBOOK_ID,
  registerMenuAction,
  useEntityRefreshStore,
  type FrontRoute,
  type MenuNode,
  type Operation,
  type RelationOps,
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
  uom_id?: string
  /** The mortgage/loan this property carries — a plain editable figure, not
   * derived from anything else. */
  loan_amount?: number
  /** The apartment's own monthly rent — a plain editable figure. Not itself
   * a billing line: the Billing lines page (below) is where the user
   * actually enters a priced "Apartment" line, typically at this figure,
   * alongside whatever other lines the month's receipt needs. */
  rent_price?: number
  /** "2026-08"-shaped, null until the first Generate — set by the Generate
   * Rent Receipt menu action. */
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

// resolveLineTaxLabel prints what a billing line's own `taxes` many2many
// actually carries (property_management_billing_line_tax junction ->
// sale_tax) as a single comma-joined label — "VAT (20%), Eco-tax (2)" — the
// receipt-line snapshot's replacement for the old, now-unused TaxRate scalar
// (property_management_billing_line_views.ts's own `tax_rate` field doc
// comment: no longer editable through the form, real tax comes from `taxes`
// exclusively). A dangling/unresolvable link is silently skipped, same
// posture generateRentReceipt already takes for a deleted contact.
async function resolveLineTaxLabel(ops: RelationOps, billingLineId: string): Promise<string> {
  const links = await ops.list('property_management_billing_line_tax', {
    filter: { property_management_billing_line_id: billingLineId },
    pageSize: 50,
  })
  const taxes = await Promise.all(
    links.map((link) =>
      typeof link.sale_tax_id === 'string' ? ops.get('sale_tax', link.sale_tax_id).catch(() => null) : null,
    ),
  )
  return taxes
    .filter((t): t is NonNullable<typeof t> => t !== null)
    .map((t) => {
      const name = String(t.name ?? '')
      return t.kind === 'fixed'
        ? `${name} (${Number(t.amount ?? 0)})`
        : `${name} (${(Number(t.rate ?? 0) * 100).toFixed(0)}%)`
    })
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
// via relationOps, create, then setFieldAndCommit). Lives in the form's
// options menu (propertyActions below), not a standalone header button —
// registerMenuAction's own MenuActionContext carries the SAME
// draft/setFieldAndCommit/relationOps a header button gets, so the workflow
// logic below is completely unchanged from when this was a header button;
// draft/setFieldAndCommit are only OPTIONAL on MenuActionContext because the
// same type also backs the bulk actions menu (menu-actions.ts's own doc
// comment) — this action is only ever wired onto a FORM descriptor's
// `actions`, where FormActionsMenu always supplies both, so the guard below
// never actually fires; TypeScript just needs it narrowed.
registerMenuAction({
  entity: 'property_management',
  name: 'propertymanagement.generateRentReceipt',
  handler: async (ctx) => {
    const { relationOps: ops, draft, setFieldAndCommit } = ctx
    if (!ops || !draft || !setFieldAndCommit) return

    const period = new Date().toISOString().slice(0, 7)
    const generatedAt = new Date().toISOString()
    const addressLine = formatPropertyAddress(draft)

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
    // rent_price prints as the billing-lines table's OWN first row now (a
    // synthetic "Rent" line, report-only — the property's own rent_price
    // field is untouched, still a plain figure, not itself a real billing
    // line), so it must also count toward the upfront estimate below —
    // otherwise Subtotal/Total would under-count by leaving it out. No tax
    // of its own: contributes equally to subtotal and total.
    const rentPrice = Number(draft.rent_price ?? 0)
    const total = rentPrice + billingLines.reduce((sum, l) => sum + Number(l.total ?? 0), 0)
    const subtotal = rentPrice + billingLines.reduce((sum, l) => sum + Number(l.subtotal ?? 0), 0)
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

    // The report prints the short SYMBOL ("m²", "ft²") next to floor_area,
    // not product_uoms' own picker label ("Square meter (m²)") — the
    // receipt's own `uom` column is this printable snapshot, same "capture
    // at document time" discipline as every other field here.
    const uomRecord =
      typeof draft.uom_id === 'string' ? await ops.get('product_uoms', draft.uom_id).catch(() => null) : null
    const uomLabel = uomRecord ? String(uomRecord.symbol ?? '') : ''

    const parent = await ops.create('property_management_rent_receipt', {
      property_management_id: ctx.recordId,
      is_parent: true,
      period,
      generated_at: generatedAt,
      property_name: draft.name,
      property_address: addressLine,
      floor_area: draft.floor_area,
      uom: uomLabel,
      rent_price: draft.rent_price,
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
        property_name: draft.name,
        property_address: addressLine,
        floor_area: draft.floor_area,
        uom: uomLabel,
        rent_price: draft.rent_price,
        subtotal,
        tax_amount: taxAmount,
        total,
        tenant_names: name,
        receipt_file: false,
      })

      // rent_price prints as the table's own FIRST row — created ahead of
      // the copied billing lines below, report-only (the property's own
      // rent_price field is untouched; this is a real
      // property_management_rent_receipt_line row, but nothing on the
      // property/billing_lines side ever reads it back). No taxes of its
      // own: subtotal/total both equal the plain figure.
      await ops.create('property_management_rent_receipt_line', {
        rent_receipt_id: child.id,
        name: 'Rent',
        unit_price: rentPrice,
        tax_label: '',
        subtotal: rentPrice,
        total: rentPrice,
      })

      // Copy the same billing lines onto this child (report-table's own
      // source, rent_receipt_report.ts) — every tenant's receipt shows the
      // property's full billing-lines table, same as the parent summary.
      // tax_label resolves the line's OWN `taxes` many2many (the plain
      // tax_rate scalar is legacy, no longer settable through the form —
      // see property_management_billing_line_views.ts's own doc comment).
      for (const line of billingLines) {
        const taxLabel = await resolveLineTaxLabel(ops, String(line.id))
        await ops.create('property_management_rent_receipt_line', {
          rent_receipt_id: child.id,
          name: line.name,
          unit_price: line.unit_price,
          tax_label: taxLabel,
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

    await setFieldAndCommit({ last_receipt_month: period })
  },
})

// Moved out of the always-visible header-button row into the form's own
// options menu (the three-dot FormActionsMenu) — the user's own explicit
// choice: a monthly, occasional action doesn't need permanent header real
// estate. states.readOnly is MenuActionNode's own parity with
// HeaderButtonDescriptor's (form-actions-menu.tsx/descriptor.ts) — the item
// stays VISIBLE but DISABLED once already run this month, never hidden, a
// server-computed key (PropertyManagement.receipt_generated_this_month
// above), never a stored column, so this Condition needs no dynamic "now"
// operator.
const propertyActions: MenuNode[] = [
  {
    kind: 'action',
    label: 'Generate Rent Receipt',
    action: 'propertymanagement.generateRentReceipt',
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
    // Blocks commit for a NEW property with no tenant picked yet — see
    // requiredMissing's doc comment (descriptor.ts) for why this only
    // enforces on create, not on editing an existing property down to zero.
    required: true,
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
    name: 'uom_id',
    label: 'Unit',
    type: 'relation',
    // filter: { type: 'surface' } scopes every search/wizard read to the
    // surface UOMs only (m², ft², ...) — floor_area is always a surface
    // measurement, so the piece/length/weight/volume/custom rows the shared
    // product_uoms catalog also carries would just be wrong picks here.
    // No client `default` here on purpose: picking one needs the workspace's
    // units.system setting plus a DB lookup, both beyond what the
    // synchronous field-function default system can do — handler.go's
    // CreateProperty resolves it server-side instead (defaultFloorAreaUom),
    // filling it in only when the create request left uom_id unset.
    relation: {
      entity: 'product_uoms',
      kind: 'many2one',
      labelField: 'name',
      filter: { type: 'surface' },
    },
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
  // own descriptor is what the wizard renders). An EXPLICIT widgetOptions.
  // columns (relation-widgets.tsx's own doc comment) replaces the generic
  // row-key derivation, which would otherwise surface the legacy tax_rate
  // scalar as a raw, unlabeled column — `taxes` here is resolved by
  // widgetOptions.relatedRelationField from the line's own `taxes` many2many
  // (billingLineFields' own tags field), and `quantity` is a plain literal
  // 1 on every row: a billing line has no quantity concept of its own (same
  // "treat absent as 1" rule TaxTotalsWidget already applies below), shown
  // anyway for the same line-items look sale's own tables have.
  // widgetOptions.previewRow prepends the property's own rent_price as a
  // synthetic leading "Rent" line, named after the property itself (this
  // record's own `name` field) — a preview of what the NEXT generated
  // receipt's billing table will actually show (rent first, then these
  // lines — rent_receipt_report.ts), before any receipt has been generated.
  {
    name: 'billing_lines',
    label: 'Billing lines',
    type: 'relation',
    widgetOptions: {
      deletable: true,
      relatedRelationField: 'taxes',
      columns: [
        { key: 'quantity', label: 'Quantity', value: 1 },
        { key: 'unit_price', label: 'Price' },
        { key: 'subtotal', label: 'Subtotal' },
        { key: 'taxes', label: 'Taxes' },
        { key: 'total', label: 'Total' },
      ],
      previewRow: { nameField: 'name', amountField: 'rent_price', amountColumns: ['unit_price', 'subtotal', 'total'] },
    },
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
  // widgetOptions.previewAmountField folds rent_price into subtotal/total
  // too, staying consistent with billing_lines' own previewRow above (both
  // show the SAME rent line, one as a grid row, one summed into the recap).
  {
    name: 'billing_totals',
    label: 'Totals',
    type: 'totals',
    hideLabel: true,
    store: false,
    widgetOptions: { previewAmountField: 'rent_price' },
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
  actions: propertyActions,
}

// Moves photos/equipment/rent_receipts off the default two-column body into
// their own notebook pages — same self-extension shape
// core/modules/sale/views/invoice_views.ts's orderLinesPageOperations uses.
export const propertyExtendOperations: Operation[] = [
  // loan_amount and rent_price BOTH sit in the right-hand column of
  // __form_columns' 2-col grid: stacked into their own single-column group
  // (no `columns` — a plain vertical Stack) placed right after
  // current_tenant, so the pair becomes ONE grid item occupying that row's
  // second column, current_tenant alone filling the first.
  {
    op: 'addNode',
    node: { kind: 'group', children: [{ kind: 'field', name: 'loan_amount' }, { kind: 'field', name: 'rent_price' }] },
    target: 'current_tenant',
    position: 'after',
  },
  // A dedicated full-width row BELOW the default 2-column body, so it
  // structurally sits under everything in __form_columns regardless of how
  // many fields that grid holds — address on the left, floor_area+uom split
  // on the right (its own nested columns: 2, floor_area left / uom right).
  // offsetTop nudges that right-hand group down to line up with address's
  // OWN zip-code/city row (AddressWidget's 4th internal row, after its
  // label + number/street + complement) — a calibrated approximation
  // (descriptor.ts's own doc comment on offsetTop), not a structural
  // binding to AddressWidget; nudge this single number if it drifts once
  // AddressWidget's own spacing changes.
  {
    op: 'addNode',
    node: {
      kind: 'group',
      columns: 2,
      children: [
        { kind: 'field', name: 'address' },
        {
          kind: 'group',
          columns: 2,
          offsetTop: 8.75,
          children: [{ kind: 'field', name: 'floor_area' }, { kind: 'field', name: 'uom_id' }],
        },
      ],
    },
    target: FORM_COLUMNS_ID,
    position: 'after',
  },
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
