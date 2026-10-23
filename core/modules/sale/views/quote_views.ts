import {
  exportReportPDF,
  FORM_COLUMNS_ID,
  FORM_NOTEBOOK_ID,
  registerFieldFunction,
  registerHeaderButtonAction,
  registerMenuAction,
  type FrontRoute,
  type HeaderButtonContext,
  type HeaderButtonDescriptor,
  type MenuNode,
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
// Confirm/Send/Accept are server-side steps (modules/sale/workflow.go,
// HeaderButtonContext.runAction): Go checks the step (a quote needs at least
// one line to be confirmed), applies it, and the form re-seeds from its
// answer — Go's refusal message shows beside the buttons. Decline is a plain
// status edit (setFieldAndCommit, the same commit() path Save uses).

function runAction(ctx: HeaderButtonContext, action: string, revalidate?: string[]) {
  if (!ctx.runAction) throw new Error('record actions are not available here')
  return ctx.runAction(action, { revalidate })
}

registerHeaderButtonAction({
  entity: 'quote',
  name: 'sale.confirmQuote',
  handler: async (ctx) => {
    await runAction(ctx, 'confirm')
  },
})

// Send emails the quote's PDF to its Customer and every Recipient (the mail
// outbox, in the same transaction as the status change) — no download here.
registerHeaderButtonAction({
  entity: 'quote',
  name: 'sale.sendQuote',
  handler: async (ctx) => {
    await runAction(ctx, 'send')
  },
})

registerHeaderButtonAction({
  entity: 'quote',
  name: 'sale.declineQuote',
  handler: async (ctx) => {
    await ctx.setFieldAndCommit({ status: 'declined' })
  },
})

// Accept converts the quote into a draft invoice, server-side and atomically
// (workflow.go's AcceptQuote): the invoice's own sequence number, the quote's
// lines at their QUOTED prices, its recipients, invoice.quote_id pointing
// back — then opens that invoice.
registerHeaderButtonAction({
  entity: 'quote',
  name: 'sale.acceptQuote',
  handler: async (ctx) => {
    const res = await runAction(ctx, 'accept', ['invoice', 'sale_line', 'invoice_recipient'])
    if (typeof res.invoice_id === 'string') ctx.navigate?.(`/sale/${res.invoice_id}`)
  },
})

// Print > Quote in the form's options menu: opens the PDF (Send emails it).
registerMenuAction({
  entity: 'quote',
  name: 'sale.printQuote',
  handler: ({ recordId }) => exportReportPDF('sale.quote', recordId),
})

const quoteFormActions: MenuNode[] = [
  { kind: 'submenu', label: 'Print', children: [{ kind: 'action', label: 'Quote', action: 'sale.printQuote' }] },
]

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
  // Never typed: Go gives every new quote the next number of the company's
  // yearly quote sequence (Q-2026-0001 — modules/sale/sequence.go).
  { name: 'number', label: 'Number', type: 'text', readOnly: true },
  // See invoice_views.ts's own fields' identical field for the full
  // rationale — kept in the compact/list set (a many2one's raw FK id isn't
  // list-renderable); customer_id below (form-only) is the primary way to
  // fill it now, auto-filling this via widgetOptions.fillFields.
  { name: 'customer_name', label: 'Customer name', type: 'text', required: true },
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
  // The list's customer_name/status columns stay declared here but don't
  // render: the Customer contact below fills the name/email snapshot (what
  // the report and Send use), and the status breadcrumb — which needs its
  // field declared — plus the workflow buttons show and move the status.
  ...quoteFields.map((f) => (f.name === 'customer_name' || f.name === 'status' ? { ...f, invisible: true } : f)),
  {
    // See invoice_views.ts's own customer_id field for the full rationale —
    // identical fillFields contract.
    name: 'customer_id',
    label: 'Customer',
    type: 'relation',
    required: true,
    relation: { entity: 'contact', kind: 'many2one', labelField: 'name' },
    widgetOptions: { fillFields: { name: 'customer_name', email: 'customer_email' } },
  },
  { name: 'customer_email', label: 'Customer email', type: 'text', invisible: true },
  { name: 'customer_address', label: 'Billing address', type: 'address', widget: 'form' },
  // No currency field — same as invoice's formFields (invoice_views.ts):
  // it's the issuing company's own property now (Settings -> Company).
  // Who else Send emails the quote to, beside the Customer — contacts linked
  // through the quote_recipient junction; Accept copies them to the invoice.
  {
    name: 'recipients',
    label: 'Recipients',
    type: 'relation',
    relation: {
      entity: 'contact',
      kind: 'many2many',
      via: 'quote_recipient',
      viaFields: { own: 'quote_id', related: 'contact_id' },
      labelField: 'name',
    },
  },
  {
    name: 'quote_lines',
    label: 'Line items',
    type: 'relation',
    relation: { entity: 'quote_line', kind: 'one2many', inverseField: 'quote_id', labelField: 'variant_name' },
    // Explicit columns, as on the invoice: the unit Go prints from the line's
    // UoM and no raw ids. A quote line has no tax tags — its tax_rate is the
    // product's percentage taxes folded together.
    widgetOptions: {
      deletable: true,
      columns: [
        { key: 'quantity', label: 'Quantity' },
        { key: 'unit', label: 'Unit' },
        { key: 'unit_price', label: 'Unit price' },
        { key: 'tax_rate', label: 'Tax rate' },
      ],
    },
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
  actions: quoteFormActions,
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

// Below the dates, two independent columns: the billing address on the left,
// who the quote goes to and how it's paid on the right (Customer, Payment
// method, Recipients). The default two-column body fills row by row, which
// put the tall address beside Customer and left a gap under it; one sub-group
// per column stacks each side on its own. Narrow forms stack the two.
export const quotePartiesOperations: Operation[] = [
  {
    op: 'addNode',
    node: {
      kind: 'group',
      id: 'quote_parties',
      columns: 2,
      children: [
        { kind: 'group', id: 'quote_parties_left', children: [{ kind: 'field', name: 'customer_address' }] },
        {
          kind: 'group',
          id: 'quote_parties_right',
          children: [
            { kind: 'field', name: 'customer_id' },
            { kind: 'field', name: 'payment_method' },
            { kind: 'field', name: 'recipients' },
          ],
        },
      ],
    },
    target: FORM_COLUMNS_ID,
    position: 'after',
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
