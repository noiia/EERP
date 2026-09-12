import {
  exportReportPDF,
  FORM_NOTEBOOK_ID,
  registerFieldFunction,
  registerHeaderButtonAction,
  type FrontRoute,
  type HeaderButtonDescriptor,
  type Operation,
  type ViewDescriptor,
} from '@eerp/core-front'

// quote — the pre-invoice proposal (module.go's doc comment on Quote), the
// same one2many master-detail shape as invoice/sale_line.

/** The Quote record as served by Go's /quote endpoints — same shape as Invoice. */
export interface Quote {
  id: string
  logo?: boolean | null
  issuer_name?: string
  // issuer_address_*/customer_address_* mirror Invoice's own composite
  // shape (invoice_views.ts).
  issuer_address_number?: number | null
  issuer_address_complement?: string
  issuer_address_street?: string
  issuer_address_zip_code?: string
  issuer_address_city?: string
  issuer_address_state?: string
  issuer_address_country?: string
  issuer_phone?: string
  issuer_email?: string
  number: string
  issue_date?: string | null
  subject?: string
  customer_id?: string | null
  customer_name: string
  customer_email?: string
  customer_address_number?: number | null
  customer_address_complement?: string
  customer_address_street?: string
  customer_address_zip_code?: string
  customer_address_city?: string
  customer_address_state?: string
  customer_address_country?: string
  /** Validity/expiry date — Quote's equivalent of Invoice's payment due_date. */
  due_date?: string | null
  /** One of the selection field's options: draft/sent/accepted/declined/expired. */
  status?: string
  reference?: string
  subtotal?: number | null
  tax_amount?: number | null
  total?: number | null
  payment_method?: string
  payment_terms?: string
  legal_notice?: string
}

// Function names are globally unique (behaviors.ts), so quote gets its own
// name even though the handler body is identical to invoice_views.ts's own.
registerFieldFunction({
  entity: 'quote',
  name: 'sale.defaultQuoteIssueDate',
  depends: [],
  handler: () => new Date().toISOString().slice(0, 10),
})

// Quote workflow (header-button-container — core-front/CLAUDE.md's "Header
// button container" row): draft -> confirmed -> sent -> accepted/declined.
// Each simple transition is a scripted field-edit-then-save through
// HeaderButtonContext.setFieldAndCommit — the SAME commit() path Save uses,
// never a separate write mechanism (see quoteHeaderButtons below for which
// button shows at which status).

registerHeaderButtonAction({
  entity: 'quote',
  name: 'sale.confirmQuote',
  handler: async (ctx) => {
    await ctx.setFieldAndCommit({ status: 'confirmed' })
  },
})

// Send both prints the quote (same "call the BFF, open the PDF" dance as
// invoice_views.ts's sale.printInvoice, over the sale.quote report) AND
// advances the status — one click does both, since "sent" only means
// something once the document is actually in the customer's hands.
registerHeaderButtonAction({
  entity: 'quote',
  name: 'sale.sendQuote',
  handler: async (ctx) => {
    await ctx.setFieldAndCommit({ status: 'sent' })
    await exportReportPDF('sale.quote', ctx.recordId)
  },
})

registerHeaderButtonAction({
  entity: 'quote',
  name: 'sale.declineQuote',
  handler: async (ctx) => {
    await ctx.setFieldAndCommit({ status: 'declined' })
  },
})

// Accept both marks the quote won AND raises the invoice it becomes — "if
// quote is accepted, an invoice is created with the data from this quote."
// ctx.relationOps is the SAME entity-generic client the relation widgets use
// (RelationOps): read this quote's own lines, snapshot the quote's fields
// onto a new invoice (linked back via quote_id — see invoice_views.ts's
// Invoice.quote_id), then create one sale_line per quote_line. sale_line's
// own Create override (handler.go) re-resolves Unit/TaxRate/UnitPrice from
// the variant/product at INVOICE creation time and recomputes the invoice's
// own totals itself (recomputeTotals) — only invoice_id/variant_id/quantity
// need passing through here, same as the invoice form's own line-items
// wizard. Ponytail: this re-prices at TODAY's product/variant rates rather
// than locking in what the quote itself snapshotted — matches every other
// sale_line/quote_line creation path in this codebase (no live joins, but
// always resolved fresh at the CREATING document's own time); revisit if the
// product ever needs quoted prices to survive unchanged onto the invoice.
registerHeaderButtonAction({
  entity: 'quote',
  name: 'sale.acceptQuote',
  handler: async (ctx) => {
    const ops = ctx.relationOps
    if (!ops) return
    const lines = await ops.list('quote_line', {
      filter: { quote_id: ctx.recordId },
      pageSize: 200,
    })
    const invoice = await ops.create('invoice', {
      issuer_name: ctx.draft.issuer_name,
      issuer_address_number: ctx.draft.issuer_address_number,
      issuer_address_complement: ctx.draft.issuer_address_complement,
      issuer_address_street: ctx.draft.issuer_address_street,
      issuer_address_zip_code: ctx.draft.issuer_address_zip_code,
      issuer_address_city: ctx.draft.issuer_address_city,
      issuer_address_state: ctx.draft.issuer_address_state,
      issuer_address_country: ctx.draft.issuer_address_country,
      issuer_phone: ctx.draft.issuer_phone,
      issuer_email: ctx.draft.issuer_email,
      number: `INV-${ctx.draft.number as string}`,
      issue_date: new Date().toISOString().slice(0, 10),
      subject: ctx.draft.subject,
      customer_id: ctx.draft.customer_id,
      customer_name: ctx.draft.customer_name,
      customer_email: ctx.draft.customer_email,
      customer_address_number: ctx.draft.customer_address_number,
      customer_address_complement: ctx.draft.customer_address_complement,
      customer_address_street: ctx.draft.customer_address_street,
      customer_address_zip_code: ctx.draft.customer_address_zip_code,
      customer_address_city: ctx.draft.customer_address_city,
      customer_address_state: ctx.draft.customer_address_state,
      customer_address_country: ctx.draft.customer_address_country,
      status: 'draft',
      reference: ctx.draft.reference,
      quote_id: ctx.recordId,
      payment_method: ctx.draft.payment_method,
      payment_terms: ctx.draft.payment_terms,
      legal_notice: ctx.draft.legal_notice,
    })
    for (const line of lines) {
      await ops.create('sale_line', {
        invoice_id: invoice.id,
        variant_id: line.variant_id,
        quantity: line.quantity,
      })
    }
    await ctx.setFieldAndCommit({ status: 'accepted' })
  },
})

// The visual slot each button occupies is entirely driven by `states.visible`
// against the live 'status' field — several entries with mutually exclusive
// conditions is how ONE slot appears to change label as the quote moves
// through its workflow (see core-front/CLAUDE.md's "Header button container").
const quoteHeaderButtons: HeaderButtonDescriptor[] = [
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
]

// quote's own field set — same shape as invoice's (invoice_views.ts), entity
// + status options swapped for the quote flow: draft -> confirmed -> sent ->
// accepted/declined, or expired at any point past due_date (see
// quoteHeaderButtons above and handler.go's expiry check) — instead of
// invoice's draft/sent/paid/overdue/cancelled.
const quoteFields: ViewDescriptor['fields'] = [
  { name: 'number', label: 'Number', type: 'text', required: true },
  { name: 'customer_name', label: 'Customer', type: 'text', required: true },
  {
    name: 'status',
    label: 'Status',
    type: 'selection',
    selection: { options: ['draft', 'confirmed', 'sent', 'accepted', 'declined', 'expired'] },
  },
  { name: 'issue_date', label: 'Issue date', type: 'date', default: 'sale.defaultQuoteIssueDate' },
  { name: 'due_date', label: 'Valid until', type: 'date' },
  { name: 'total', label: 'Total', type: 'number', widget: 'float', readOnly: true },
]

const quoteFormFields: ViewDescriptor['fields'] = [
  {
    name: 'logo',
    hideLabel: true,
    label: 'Company logo',
    type: 'boolean',
    widget: 'picture',
  },
  ...quoteFields,
  { name: 'subject', label: 'Subject', type: 'text' },
  {
    name: 'customer_id',
    label: 'Linked customer',
    type: 'relation',
    relation: { entity: 'contact', kind: 'many2one', labelField: 'name' },
  },
  { name: 'customer_email', label: 'Customer email', type: 'text' },
  { name: 'customer_address', label: 'Billing address', type: 'address', widget: 'form' },
  // No currency field — same as invoice's formFields (invoice_views.ts):
  // it's the issuing company's own property now (Settings -> Company).
  { name: 'reference', label: 'Reference', type: 'text' },
  {
    name: 'quote_lines',
    label: 'Line items',
    type: 'relation',
    relation: { entity: 'quote_line', kind: 'one2many', inverseField: 'quote_id', labelField: 'variant_name' },
  },
  // Same totals recap as invoice's sale_totals, scoped to this quote's own
  // lines — see invoice_views.ts's formFields for the full doc comment.
  {
    name: 'quote_totals',
    label: 'Totals',
    type: 'totals',
    hideLabel: true,
    store: false,
    relation: { entity: 'quote_line', kind: 'one2many', inverseField: 'quote_id' },
  },
  { name: 'payment_method', label: 'Payment method', type: 'text' },
  { name: 'payment_terms', label: 'Payment terms', type: 'text', widget: 'long' },
  { name: 'legal_notice', label: 'Legal notice', type: 'text', widget: 'long' },
]

const quoteListView: ViewDescriptor = {
  entity: 'quote',
  viewType: 'tree',
  fields: quoteFields,
  formPath: '/sale/quote/:id',
  createPermission: 'quote:quote:write',
  permissions: ['quote:quote:read'],
}

const quoteFormView: ViewDescriptor = {
  entity: 'quote',
  viewType: 'form',
  fields: quoteFormFields,
  permissions: ['quote:quote:read'],
  statusBar: { field: 'status' },
  headerButtons: quoteHeaderButtons,
}

// Moves quote_lines (+ its totals recap) into its own first-position
// notebook page, same self-extension shape as invoice_views.ts's
// orderLinesPageOperations. removeField('total') first: 'total' is still
// part of quoteFields (spread into quoteFormFields for the compact
// tree/dashboard columns) and would otherwise land in the default
// two-column body as a bare field — quote_totals now shows it as part of
// the recap instead.
export const quoteLinesPageOperations: Operation[] = [
  { op: 'removeField', name: 'total' },
  {
    op: 'addNode',
    node: {
      kind: 'page',
      title: 'Quote lines',
      children: [{ kind: 'field', name: 'quote_lines' }, { kind: 'field', name: 'quote_totals' }],
    },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
]

// Routes this file contributes to sale_views.ts's assembled FrontModule —
// registered BEFORE invoice's own routes: the dashboard rolls a module's
// tree views into tiles in registration order (resolve.ts's
// dashboardListViews over ModuleRegistry.listViews, same mechanism
// core/modules/warehouse/views/warehouse_views.ts documents), so THIS
// ordering alone is what makes the Quote tile the first dashboard tile.
export const quoteRoutes: FrontRoute[] = [
  { path: '/sale/quote/list', descriptor: quoteListView, permission: 'quote:quote:read' },
  { path: '/sale/quote/:id', descriptor: quoteFormView, permission: 'quote:quote:read' },
]
