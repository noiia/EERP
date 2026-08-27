import {
  exportReportPDF,
  FORM_NOTEBOOK_ID,
  registerFieldFunction,
  registerHeaderButtonAction,
  registerMenuAction,
  reportPartyAddressFields,
  reportTitleSection,
  type FrontModule,
  type HeaderButtonDescriptor,
  type MenuNode,
  type Operation,
  type ReportDescriptor,
  type ViewDescriptor,
} from '@eerp/core-front'

// Sale frontend — DESCRIPTORS ONLY (same discipline as core/modules/crm's
// CrmViews.ts). Four entities: 'invoice' + 'sale_line' (the billing
// document and its line items) and 'quote' + 'quote_line' (the pre-invoice
// proposal — module.go's doc comment on Quote), each pair the same
// one2many master-detail shape core/modules/contact's contact/crm pair
// already uses. Every `entity` name is the Go route prefix from
// module.go's orm.Register calls — NOT the module slug 'sale'.

/** The Invoice record as served by Go's /invoice endpoints (BaseModel + business fields). */
export interface Invoice {
  id: string
  /** true ⇔ a picture exists on this record's logo anchor (picture service). */
  logo?: boolean | null
  issuer_name?: string
  // issuer_address_* — the type: 'address' composite field's 7 sibling
  // columns (core-front's AddressWidget). Never edited on the invoice form
  // itself (see formFields below) — blank falls back to the active
  // company's own address at print time (invoiceReport's companyFallback).
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
  /** Bill-to snapshot, captured at invoice time — see module.go's doc comment. */
  customer_name: string
  customer_email?: string
  // customer_address_* mirrors issuer_address_*'s composite shape — edited
  // on the form (type: 'address' widget, formFields below).
  customer_address_number?: number | null
  customer_address_complement?: string
  customer_address_street?: string
  customer_address_zip_code?: string
  customer_address_city?: string
  customer_address_state?: string
  customer_address_country?: string
  due_date?: string | null
  /** One of the selection field's options: draft/sent/paid/overdue/cancelled. */
  status?: string
  reference?: string
  /** The quote this invoice was created FROM (sale.acceptQuote header button
   * handler below) — null for an invoice raised directly, never through a
   * quote's Accept flow. */
  quote_id?: string | null
  subtotal?: number | null
  tax_amount?: number | null
  total?: number | null
  payment_method?: string
  payment_terms?: string
  legal_notice?: string
}

/** One sale_line row — a line item snapshotted from a product.variant. */
export interface SaleLine {
  id: string
  invoice_id: string
  variant_id: string
  variant_name?: string
  quantity: number
  unit?: string
  /** 0..1 ratio, snapshotted from the product; the percent widget displays it ×100. */
  tax_rate?: number
  unit_price?: number
}

/** The Quote record as served by Go's /quote endpoints — same shape as Invoice. */
export interface Quote {
  id: string
  logo?: boolean | null
  issuer_name?: string
  // issuer_address_*/customer_address_* mirror Invoice's own composite
  // shape above.
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

/** One quote_line row — mirrors SaleLine, scoped to a Quote. */
export interface QuoteLine {
  id: string
  quote_id: string
  variant_id: string
  variant_name?: string
  quantity: number
  unit?: string
  tax_rate?: number
  unit_price?: number
}

// default as a FUNCTION (same name-not-function rule as compute): a new
// invoice starts dated today, same pattern as crm.defaultSatisfaction.
registerFieldFunction({
  entity: 'invoice',
  name: 'sale.defaultIssueDate',
  depends: [],
  handler: () => new Date().toISOString().slice(0, 10),
})

// Function names are globally unique (behaviors.ts), so quote gets its own
// name even though the handler body is identical to invoice's above.
registerFieldFunction({
  entity: 'quote',
  name: 'sale.defaultQuoteIssueDate',
  depends: [],
  handler: () => new Date().toISOString().slice(0, 10),
})

// sale.printInvoice — the invoice form's Print > Invoice menu action
// (docs/adr/ADR-011), reusing the exact "call the BFF, open the PDF" logic
// the old ReportExportButton had (exportReportPDF, engine-shared) rather than
// duplicating the fetch dance here.
registerMenuAction({
  entity: 'invoice',
  name: 'sale.printInvoice',
  handler: ({ recordId }) => exportReportPDF('sale.invoice', recordId),
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
// sale.printInvoice above, over the sale.quote report below) AND advances
// the status — one click does both, since "sent" only means something once
// the document is actually in the customer's hands.
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
// onto a new invoice (linked back via quote_id — see Invoice.quote_id
// above), then create one sale_line per quote_line. sale_line's own Create
// override (handler.go) re-resolves Unit/TaxRate/UnitPrice from the
// variant/product at INVOICE creation time and recomputes the invoice's own
// totals itself (recomputeTotals) — only invoice_id/variant_id/quantity need
// passing through here, same as the invoice form's own line-items wizard.
// Ponytail: this re-prices at TODAY's product/variant rates rather than
// locking in what the quote itself snapshotted — matches every other
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

const fields: ViewDescriptor['fields'] = [
  { name: 'number', label: 'Number', type: 'text', required: true },
  { name: 'customer_name', label: 'Customer', type: 'text', required: true },
  {
    name: 'status',
    label: 'Status',
    type: 'selection',
    selection: { options: ['draft', 'sent', 'paid', 'overdue', 'cancelled'] },
  },
  { name: 'issue_date', label: 'Issue date', type: 'date', default: 'sale.defaultIssueDate' },
  { name: 'due_date', label: 'Due date', type: 'date' },
  { name: 'total', label: 'Total', type: 'number', widget: 'float', readOnly: true },
]

// Everything below renders on the FORM only (same split as crm's
// contact_id/tags): the list's DataGrid stays to the compact scalar set above.
const formFields: ViewDescriptor['fields'] = [
  {
    name: 'logo',
    hideLabel: true,
    label: 'Company logo',
    type: 'boolean',
    widget: 'picture',
  },
  ...fields,
  { name: 'subject', label: 'Subject', type: 'text' },
  {
    name: 'customer_id',
    label: 'Linked customer',
    type: 'relation',
    relation: { entity: 'contact', kind: 'many2one', labelField: 'name' },
  },
  { name: 'customer_email', label: 'Customer email', type: 'text' },
  { name: 'customer_address', label: 'Billing address', type: 'address', widget: 'form' },
  // No currency field: currency is now the ISSUING COMPANY's own property
  // (internal/company.Company.Currency, Settings -> Company), not duplicated
  // per document.
  { name: 'reference', label: 'Reference', type: 'text' },
  // System-set provenance link, never hand-picked: sale.acceptQuote (below)
  // is the only writer, at invoice-creation time. readOnly rather than
  // omitted from the form entirely — a user should be able to SEE which
  // quote (if any) an invoice came from.
  {
    name: 'quote_id',
    label: 'Quote',
    type: 'relation',
    readOnly: true,
    relation: { entity: 'quote', kind: 'many2one', labelField: 'number' },
  },
  // Real child table (core/modules/sale/module.go's SaleLine), not the old
  // Lines JSONB blob — the invoice's line-items table. Adding/removing rows
  // goes through the engine's one2many grid + create wizard
  // (RelationListWidget); each mutation is a real POST/PUT/DELETE against
  // /api/v1/sale_line, which is what recomputes subtotal/tax_amount/total
  // server-side (see handler.go) — not a client-side compute. Declared here
  // so it exists as a field at all; orderLinesPageOperations below (via the
  // module's own `extends`) is what actually MOVES it, and sale_totals right
  // after it, off the two-column body and into their own first-position
  // notebook page — this array's declaration order no longer decides where
  // it renders on the form.
  {
    name: 'sale_lines',
    label: 'Line items',
    type: 'relation',
    relation: { entity: 'sale_line', kind: 'one2many', inverseField: 'invoice_id', labelField: 'variant_name' },
  },
  // The HT -> tax-by-rate -> TTC recap block (docs/roadmaps — sale totals):
  // computes itself, live, from the SAME sale_lines above (each line's own
  // tax_rate, from its product/variant) rather than reading the stored
  // subtotal/tax_amount/total columns — see widgets.tsx's TaxTotalsWidget.
  // store: false — nothing here round-trips to the server.
  {
    name: 'sale_totals',
    label: 'Totals',
    type: 'totals',
    hideLabel: true,
    store: false,
    relation: { entity: 'sale_line', kind: 'one2many', inverseField: 'invoice_id' },
  },
  { name: 'payment_method', label: 'Payment method', type: 'text' },
  { name: 'payment_terms', label: 'Payment terms', type: 'text', widget: 'long' },
  { name: 'legal_notice', label: 'Legal notice', type: 'text', widget: 'long' },
]

// quote's own field set — same shape as invoice's above, entity + status
// options swapped for the quote flow: draft -> confirmed -> sent ->
// accepted/declined, or expired at any point past due_date (see
// quoteHeaderButtons below and handler.go's expiry check) — instead of
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
  // No currency field — same as invoice's formFields: it's the issuing
  // company's own property now (Settings -> Company).
  { name: 'reference', label: 'Reference', type: 'text' },
  {
    name: 'quote_lines',
    label: 'Line items',
    type: 'relation',
    relation: { entity: 'quote_line', kind: 'one2many', inverseField: 'quote_id', labelField: 'variant_name' },
  },
  // Same totals recap as invoice's sale_totals, scoped to this quote's own
  // lines — see formFields above for the full doc comment.
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

// quote_line's own descriptor — needed for the quote form's one2many
// create-wizard, same reasoning as saleLineFields below.
const quoteLineFields: ViewDescriptor['fields'] = [
  {
    name: 'quote_id',
    label: 'Quote',
    type: 'relation',
    required: true,
    relation: { entity: 'quote', kind: 'many2one', labelField: 'number' },
  },
  {
    name: 'variant_id',
    label: 'Product variant',
    type: 'relation',
    required: true,
    relation: { entity: 'product_variant', kind: 'many2one', labelField: 'name' },
  },
  { name: 'quantity', label: 'Quantity', type: 'number', required: true },
  { name: 'unit', label: 'Unit', type: 'text', readOnly: true },
  { name: 'tax_rate', label: 'Tax', type: 'number', widget: 'percent', readOnly: true },
  { name: 'unit_price', label: 'Unit price (excl. tax)', type: 'number', widget: 'float', readOnly: true },
]

const quoteLineFormView: ViewDescriptor = {
  entity: 'quote_line',
  viewType: 'form',
  fields: quoteLineFields,
  permissions: ['quote_line:quote_line:read'],
}

// Moves quote_lines (+ its totals recap) into its own first-position
// notebook page, same self-extension shape as orderLinesPageOperations
// below. removeField('total') first: 'total' is still part of quoteFields
// (spread into quoteFormFields for the compact tree/dashboard columns) and
// would otherwise land in the default two-column body as a bare field —
// quote_totals now shows it as part of the recap instead.
const quoteLinesPageOperations: Operation[] = [
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

const dashboardView: ViewDescriptor = {
  entity: 'invoice',
  viewType: 'dashboard',
  fields,
  permissions: ['invoice:invoice:read'],
}

const listView: ViewDescriptor = {
  entity: 'invoice',
  viewType: 'tree',
  fields,
  formPath: '/sale/:id',
  createPermission: 'invoice:invoice:write',
  permissions: ['invoice:invoice:read'],
}

// The invoice form's options menu (docs/adr/ADR-011): one submenu, Print,
// holding the Invoice action registered above.
const formActions: MenuNode[] = [
  {
    kind: 'submenu',
    label: 'Print',
    children: [{ kind: 'action', label: 'Invoice', action: 'sale.printInvoice' }],
  },
]

const formView: ViewDescriptor = {
  entity: 'invoice',
  viewType: 'form',
  fields: formFields,
  permissions: ['invoice:invoice:read'],
  actions: formActions,
  // Read-only status breadcrumb, top-right of the top toolbar (see
  // StatusBarDescriptor's own doc comment): steps come straight from the
  // 'status' field's own selection.options above, so this never re-declares
  // the vocabulary — it just points at it.
  statusBar: { field: 'status' },
}

// Moves sale_lines (+ its totals recap) off the default anatomy's
// two-column body and into its own notebook page, "Order lines" — same
// self-extension shape core/modules/crm/views/CrmViews.ts uses for its
// Signature page (addField there is unnecessary here since sale_lines is
// already declared in formFields above; addNode alone both creates the page
// AND extracts the field from wherever it currently sits into it).
// `position: 'first'` against FORM_NOTEBOOK_ID inserts it as the notebook's
// first tab, ahead of the synthesized "Settings" page (customer_address/
// payment_terms/legal_notice) — the invoice's line items are the first
// thing a user sees past the header, not squeezed in wherever declaration
// order happened to put it. removeField('total') first: 'total' is still
// part of `fields` (spread into formFields for the compact tree/dashboard
// columns) and would otherwise land in the default two-column body as a
// bare field — sale_totals now shows it as part of the recap instead.
const orderLinesPageOperations: Operation[] = [
  { op: 'removeField', name: 'total' },
  {
    op: 'addNode',
    node: {
      kind: 'page',
      title: 'Order lines',
      children: [{ kind: 'field', name: 'sale_lines' }, { kind: 'field', name: 'sale_totals' }],
    },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
]

// sale_line's own descriptor — needed so the invoice form's one2many
// create-wizard (RelationListWidget/RelationCreateWizard) has a form to
// render: invoice_id is preset+hidden by the wizard's context (same
// contact.crm_records/contact_id pattern), variant_id is the line's real
// "product.variant many2one" first column, and unit/tax_rate/unit_price are
// read-only because the backend snapshots them from the chosen variant's
// product (core/modules/sale/handler.go) — never hand-typed.
const saleLineFields: ViewDescriptor['fields'] = [
  {
    name: 'invoice_id',
    label: 'Invoice',
    type: 'relation',
    required: true,
    relation: { entity: 'invoice', kind: 'many2one', labelField: 'number' },
  },
  {
    name: 'variant_id',
    label: 'Product variant',
    type: 'relation',
    required: true,
    relation: { entity: 'product_variant', kind: 'many2one', labelField: 'name' },
  },
  { name: 'quantity', label: 'Quantity', type: 'number', required: true },
  { name: 'unit', label: 'Unit', type: 'text', readOnly: true },
  { name: 'tax_rate', label: 'Tax', type: 'number', widget: 'percent', readOnly: true },
  { name: 'unit_price', label: 'Unit price (excl. tax)', type: 'number', widget: 'float', readOnly: true },
]

const saleLineFormView: ViewDescriptor = {
  entity: 'sale_line',
  viewType: 'form',
  fields: saleLineFields,
  permissions: ['sale_line:sale_line:read'],
}

/** One right-aligned "label / amount" row in the totals recap block. */
function totalsRow(label: string, field: string, grand = false): ReportDescriptor['layout'][number] {
  return {
    kind: 'section',
    className: grand ? 'eerp-report-totals-row eerp-report-totals-row--grand' : 'eerp-report-totals-row',
    children: [
      { kind: 'text', text: label },
      { kind: 'field', name: field, format: 'number' },
    ],
  }
}

// sale.invoice — a real, printable invoice PDF modeled on a standard
// letterhead invoice/devis template (docs/adr/ADR-011): logo top-left, issue
// date + number top-right, issuer/client two-column block, a subject line,
// a bordered item table, a right-aligned HT/discount/TVA/TTC totals recap,
// and small-print payment terms + legal notice. className hooks come from
// apps/shell/app/print/report/report.css's eerp-report-* rules — neutral
// grays/black, not the reference template's own green brand color. No
// pageBreak: this is a realistic one-page document, unlike crm.statement
// (which exists partly to prove that node kind).
const invoiceReport: ReportDescriptor = {
  name: 'sale.invoice',
  entity: 'invoice',
  permissions: ['invoice:invoice:read'],
  layout: [
    {
      kind: 'section',
      className: 'eerp-report-masthead',
      children: [
        { kind: 'image', source: 'logo', className: 'eerp-report-logo', alt: 'Company logo' },
        {
          kind: 'section',
          className: 'eerp-report-doc-meta',
          children: [
            { kind: 'field', name: 'issue_date', format: 'date' },
            { kind: 'field', name: 'number' },
          ],
        },
      ],
    },
    {
      // The default report masthead (report-descriptor.ts's
      // reportMastheadSection, composed by hand here so issuer/customer keep
      // their own extra phone/email lines): the printing company's address
      // top-left — falling back to the active company profile when the
      // invoice's own issuer_* snapshot is blank (multi-company; the
      // invoice's own columns/form fields are UNCHANGED, still editable,
      // still snapshotted on create) — and the customer's address top-right,
      // its own fields only, no fallback.
      kind: 'section',
      className: 'eerp-report-parties',
      children: [
        {
          kind: 'section',
          className: 'eerp-report-issuer',
          children: [
            ...reportPartyAddressFields('issuer', true),
            { kind: 'field', name: 'issuer_phone', companyFallback: 'phone' },
            { kind: 'field', name: 'issuer_email', companyFallback: 'email' },
          ],
        },
        {
          kind: 'section',
          className: 'eerp-report-client',
          children: [...reportPartyAddressFields('customer', false), { kind: 'field', name: 'customer_email' }],
        },
      ],
    },
    // The document's own name/title, big (report.css's eerp-report-title) —
    // 'subject' is a plain, already-editable text field on the invoice form,
    // just printed oversized here instead of the old small "Subject:" line.
    reportTitleSection('subject'),
    {
      kind: 'table',
      source: 'lines',
      className: 'eerp-report-table',
      // sale_line rows live in their own table now — the print route
      // fetches them (filtered by invoice_id) and assigns them onto
      // record.lines before this node ever renders (see
      // report-descriptor.ts's ReportTableNode.relation doc comment).
      relation: { entity: 'sale_line', inverseField: 'invoice_id' },
      columns: [
        { name: 'variant_name', label: 'Product' },
        { name: 'unit', label: 'Unit' },
        { name: 'quantity', label: 'Quantity' },
        { name: 'unit_price', label: 'Unit price' },
        { name: 'tax_rate', label: 'Tax' },
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-totals',
      children: [
        totalsRow('Subtotal (excl. tax)', 'subtotal'),
        totalsRow('Tax', 'tax_amount'),
        totalsRow('Total (incl. tax)', 'total', true),
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-payment',
      children: [
        { kind: 'text', text: 'Payment method:', className: 'eerp-report-label' },
        { kind: 'field', name: 'payment_method' },
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-payment',
      children: [
        { kind: 'text', text: 'Payment terms:', className: 'eerp-report-label' },
        { kind: 'field', name: 'payment_terms' },
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-payment',
      children: [
        { kind: 'text', text: 'Due date:', className: 'eerp-report-label' },
        { kind: 'field', name: 'due_date', format: 'date' },
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-footer',
      children: [{ kind: 'field', name: 'legal_notice' }],
    },
  ],
}

// sale.quote — the quote's own printable PDF, triggered by the Send header
// button above (sale.sendQuote). Mirrors invoiceReport field-for-field
// (same letterhead template — Quote's own doc comment in module.go), scoped
// to quote/quote_line instead of invoice/sale_line; the only textual
// difference is "Valid until:" instead of "Due date:", matching the form's
// own due_date label ("Valid until" — a quote's due_date is an expiry, not
// a payment deadline).
const quoteReport: ReportDescriptor = {
  name: 'sale.quote',
  entity: 'quote',
  permissions: ['quote:quote:read'],
  layout: [
    {
      kind: 'section',
      className: 'eerp-report-masthead',
      children: [
        { kind: 'image', source: 'logo', className: 'eerp-report-logo', alt: 'Company logo' },
        {
          kind: 'section',
          className: 'eerp-report-doc-meta',
          children: [
            { kind: 'field', name: 'issue_date', format: 'date' },
            { kind: 'field', name: 'number' },
          ],
        },
      ],
    },
    {
      // Same masthead composition as invoiceReport above (report-descriptor.ts's
      // reportPartyAddressFields, plus issuer/customer's own phone/email lines).
      kind: 'section',
      className: 'eerp-report-parties',
      children: [
        {
          kind: 'section',
          className: 'eerp-report-issuer',
          children: [
            ...reportPartyAddressFields('issuer', true),
            { kind: 'field', name: 'issuer_phone', companyFallback: 'phone' },
            { kind: 'field', name: 'issuer_email', companyFallback: 'email' },
          ],
        },
        {
          kind: 'section',
          className: 'eerp-report-client',
          children: [...reportPartyAddressFields('customer', false), { kind: 'field', name: 'customer_email' }],
        },
      ],
    },
    reportTitleSection('subject'),
    {
      kind: 'table',
      source: 'lines',
      className: 'eerp-report-table',
      relation: { entity: 'quote_line', inverseField: 'quote_id' },
      columns: [
        { name: 'variant_name', label: 'Product' },
        { name: 'unit', label: 'Unit' },
        { name: 'quantity', label: 'Quantity' },
        { name: 'unit_price', label: 'Unit price' },
        { name: 'tax_rate', label: 'Tax' },
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-totals',
      children: [
        totalsRow('Subtotal (excl. tax)', 'subtotal'),
        totalsRow('Tax', 'tax_amount'),
        totalsRow('Total (incl. tax)', 'total', true),
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-payment',
      children: [
        { kind: 'text', text: 'Payment method:', className: 'eerp-report-label' },
        { kind: 'field', name: 'payment_method' },
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-payment',
      children: [
        { kind: 'text', text: 'Payment terms:', className: 'eerp-report-label' },
        { kind: 'field', name: 'payment_terms' },
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-payment',
      children: [
        { kind: 'text', text: 'Valid until:', className: 'eerp-report-label' },
        { kind: 'field', name: 'due_date', format: 'date' },
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-footer',
      children: [{ kind: 'field', name: 'legal_notice' }],
    },
  ],
}

const sale: FrontModule = {
  name: 'sale',
  routes: [
    { path: '/sale', descriptor: dashboardView, permission: 'invoice:invoice:read' },
    // quote's tree view is registered BEFORE invoice's — the dashboard rolls
    // a module's tree views into tiles in registration order (resolve.ts's
    // dashboardListViews over ModuleRegistry.listViews, same mechanism
    // core/modules/warehouse/views/WarehouseViews.ts documents), so this
    // ordering alone is what makes the Quote tile the first dashboard tile.
    { path: '/sale/quote/list', descriptor: quoteListView, permission: 'quote:quote:read' },
    { path: '/sale/quote/:id', descriptor: quoteFormView, permission: 'quote:quote:read' },
    { path: '/sale/quote/lines/:id', descriptor: quoteLineFormView, permission: 'quote_line:quote_line:read' },
    { path: '/sale/list', descriptor: listView, permission: 'invoice:invoice:read' },
    { path: '/sale/:id', descriptor: formView, permission: 'invoice:invoice:read' },
    { path: '/sale/lines/:id', descriptor: saleLineFormView, permission: 'sale_line:sale_line:read' },
  ],
  reports: [invoiceReport, quoteReport],
  extends: [
    { path: '/sale/:id', operations: orderLinesPageOperations },
    { path: '/sale/quote/:id', operations: quoteLinesPageOperations },
  ],
}

export default sale
