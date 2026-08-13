import {
  exportReportPDF,
  FORM_NOTEBOOK_ID,
  registerFieldFunction,
  registerMenuAction,
  type FrontModule,
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
  issuer_address?: string
  issuer_phone?: string
  issuer_email?: string
  number: string
  issue_date?: string | null
  subject?: string
  customer_id?: string | null
  /** Bill-to snapshot, captured at invoice time — see module.go's doc comment. */
  customer_name: string
  customer_email?: string
  customer_address?: string
  due_date?: string | null
  /** One of the selection field's options: draft/sent/paid/overdue/cancelled. */
  status?: string
  currency?: string
  reference?: string
  subtotal?: number | null
  discount?: number | null
  net_subtotal?: number | null
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
  issuer_address?: string
  issuer_phone?: string
  issuer_email?: string
  number: string
  issue_date?: string | null
  subject?: string
  customer_id?: string | null
  customer_name: string
  customer_email?: string
  customer_address?: string
  /** Validity/expiry date — Quote's equivalent of Invoice's payment due_date. */
  due_date?: string | null
  /** One of the selection field's options: draft/sent/accepted/declined/expired. */
  status?: string
  currency?: string
  reference?: string
  subtotal?: number | null
  discount?: number | null
  net_subtotal?: number | null
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
  { name: 'customer_address', label: 'Billing address', type: 'text', widget: 'long' },
  {
    name: 'currency',
    label: 'Currency',
    type: 'selection',
    selection: { options: ['USD', 'EUR', 'GBP'] },
  },
  { name: 'reference', label: 'Reference', type: 'text' },
  // Real child table (core/modules/sale/module.go's SaleLine), not the old
  // Lines JSONB blob — the invoice's line-items table. Adding/removing rows
  // goes through the engine's one2many grid + create wizard
  // (RelationListWidget); each mutation is a real POST/PUT/DELETE against
  // /api/v1/sale_line, which is what recomputes subtotal/tax_amount/total
  // below (see handler.go) — not a client-side compute. Declared here so it
  // exists as a field at all; orderLinesPageOperations below (via the
  // module's own `extends`) is what actually MOVES it off the two-column
  // body and into its own first-position notebook page — this array's
  // declaration order no longer decides where it renders on the form.
  {
    name: 'sale_lines',
    label: 'Line items',
    type: 'relation',
    relation: { entity: 'sale_line', kind: 'one2many', inverseField: 'invoice_id', labelField: 'variant_name' },
  },
  // Subtotal/NetSubtotal/TaxAmount/Total are now rollups over sale_lines,
  // computed server-side (handler.go's recomputeTotals) — never typed here.
  { name: 'subtotal', label: 'Subtotal (excl. tax)', type: 'number', widget: 'float', readOnly: true },
  { name: 'discount', label: 'Discount (excl. tax)', type: 'number', widget: 'float' },
  { name: 'net_subtotal', label: 'Net subtotal (excl. tax)', type: 'number', widget: 'float', readOnly: true },
  { name: 'tax_amount', label: 'Tax amount', type: 'number', widget: 'float', readOnly: true },
  { name: 'payment_method', label: 'Payment method', type: 'text' },
  { name: 'payment_terms', label: 'Payment terms', type: 'text', widget: 'long' },
  { name: 'legal_notice', label: 'Legal notice', type: 'text', widget: 'long' },
]

// quote's own field set — same shape as invoice's above, entity + status
// options swapped for the quote flow (draft/sent/accepted/declined/expired
// instead of draft/sent/paid/overdue/cancelled).
const quoteFields: ViewDescriptor['fields'] = [
  { name: 'number', label: 'Number', type: 'text', required: true },
  { name: 'customer_name', label: 'Customer', type: 'text', required: true },
  {
    name: 'status',
    label: 'Status',
    type: 'selection',
    selection: { options: ['draft', 'sent', 'accepted', 'declined', 'expired'] },
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
  { name: 'customer_address', label: 'Billing address', type: 'text', widget: 'long' },
  {
    name: 'currency',
    label: 'Currency',
    type: 'selection',
    selection: { options: ['USD', 'EUR', 'GBP'] },
  },
  { name: 'reference', label: 'Reference', type: 'text' },
  {
    name: 'quote_lines',
    label: 'Line items',
    type: 'relation',
    relation: { entity: 'quote_line', kind: 'one2many', inverseField: 'quote_id', labelField: 'variant_name' },
  },
  { name: 'subtotal', label: 'Subtotal (excl. tax)', type: 'number', widget: 'float', readOnly: true },
  { name: 'discount', label: 'Discount (excl. tax)', type: 'number', widget: 'float' },
  { name: 'net_subtotal', label: 'Net subtotal (excl. tax)', type: 'number', widget: 'float', readOnly: true },
  { name: 'tax_amount', label: 'Tax amount', type: 'number', widget: 'float', readOnly: true },
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

// Moves quote_lines into its own first-position notebook page, same
// self-extension shape as orderLinesPageOperations below.
const quoteLinesPageOperations: Operation[] = [
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Quote lines', children: [{ kind: 'field', name: 'quote_lines' }] },
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

// Moves sale_lines off the default anatomy's two-column body and into its
// own notebook page, "Order lines" — same self-extension shape
// core/modules/crm/views/CrmViews.ts uses for its Signature page
// (addField there is unnecessary here since sale_lines is already declared
// in formFields above; addNode alone both creates the page AND extracts the
// field from wherever it currently sits into it). `position: 'first'`
// against FORM_NOTEBOOK_ID inserts it as the notebook's first tab, ahead of
// the synthesized "Settings" page (customer_address/payment_terms/
// legal_notice) — the invoice's line items are the first thing a user sees
// past the header, not squeezed in wherever declaration order happened to
// put it.
const orderLinesPageOperations: Operation[] = [
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Order lines', children: [{ kind: 'field', name: 'sale_lines' }] },
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
      kind: 'section',
      className: 'eerp-report-parties',
      children: [
        {
          kind: 'section',
          className: 'eerp-report-issuer',
          // companyFallback (multi-company): when an invoice's own issuer_*
          // snapshot is blank, the print route fills it in from the printing
          // user's active company profile instead — the invoice's own
          // columns/form fields are UNCHANGED (still editable, still
          // snapshotted on create); removing them as now-redundant is a
          // deliberately separate, later pass.
          children: [
            { kind: 'field', name: 'issuer_name', companyFallback: 'name' },
            { kind: 'field', name: 'issuer_address', companyFallback: 'address' },
            { kind: 'field', name: 'issuer_phone', companyFallback: 'phone' },
            { kind: 'field', name: 'issuer_email', companyFallback: 'email' },
          ],
        },
        {
          kind: 'section',
          className: 'eerp-report-client',
          children: [
            { kind: 'field', name: 'customer_name' },
            { kind: 'field', name: 'customer_address' },
            { kind: 'field', name: 'customer_email' },
          ],
        },
      ],
    },
    {
      kind: 'section',
      className: 'eerp-report-subject',
      children: [
        { kind: 'text', text: 'Subject:', className: 'eerp-report-label' },
        { kind: 'field', name: 'subject' },
      ],
    },
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
        totalsRow('Discount (excl. tax)', 'discount'),
        totalsRow('Net subtotal (excl. tax)', 'net_subtotal'),
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
  reports: [invoiceReport],
  extends: [
    { path: '/sale/:id', operations: orderLinesPageOperations },
    { path: '/sale/quote/:id', operations: quoteLinesPageOperations },
  ],
}

export default sale
