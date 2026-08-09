import {
  exportReportPDF,
  registerFieldFunction,
  registerMenuAction,
  registerOnChange,
  type DraftRecord,
  type FrontModule,
  type MenuNode,
  type ReportDescriptor,
  type ViewDescriptor,
} from '@eerp/core-front'

// Sale frontend — DESCRIPTORS ONLY (same discipline as core/modules/crm's
// CrmViews.ts). The dashboard has a single section, Invoice: one dashboard
// tile derived from the entity's own tree view (DashboardRenderer renders
// one card per tree view the module owns — there is no separate
// "dashboard section" construct in the engine).
//
// `entity` is 'invoice' — the Go route prefix from module.go's
// orm.Register[Invoice] (GET /api/v1/invoice) — NOT the module slug 'sale'.

/** One row of the invoice's item table (Lines, a JSONB array — module.go). */
export interface InvoiceLine {
  description?: string
  unit?: string
  quantity?: number
  unit_price?: number
  vat_rate?: number
  total_ht?: number
}

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
  lines?: InvoiceLine[]
  subtotal?: number | null
  discount?: number | null
  net_subtotal?: number | null
  /** 0..1 ratio; the percent widget displays it ×100. */
  tax_rate?: number | null
  tax_amount?: number | null
  total?: number | null
  payment_method?: string
  payment_terms?: string
  legal_notice?: string
}

// default as a FUNCTION (same name-not-function rule as compute): a new
// invoice starts dated today, same pattern as crm.defaultSatisfaction.
registerFieldFunction({
  entity: 'invoice',
  name: 'sale.defaultIssueDate',
  depends: [],
  handler: () => new Date().toISOString().slice(0, 10),
})

// on_change (not compute): the HT -> TVA -> TTC chain must land in real
// committed columns, not store:false computes, because the PDF report reads
// the raw record — never the client compute registry (see module.go).
// Re-suggested whenever Subtotal/Discount/TaxRate change; the user stays
// free to override any of the three results, exactly like
// crm.scoreFromStatus's Score.
registerOnChange({
  entity: 'invoice',
  name: 'sale.calcTotal',
  onChange: ['subtotal', 'discount', 'tax_rate'],
  handler: (draft: Readonly<DraftRecord>) => {
    const subtotal = Number(draft.subtotal ?? 0)
    const discount = Number(draft.discount ?? 0)
    const taxRate = Number(draft.tax_rate ?? 0)
    const netSubtotal = subtotal - discount
    const taxAmount = netSubtotal * taxRate
    return { net_subtotal: netSubtotal, tax_amount: taxAmount, total: netSubtotal + taxAmount }
  },
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
  { name: 'total', label: 'Total', type: 'number', widget: 'float' },
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
  // Issuer* is the seller's own letterhead block (module.go's doc comment) —
  // a per-invoice snapshot, since no workspace-wide "company profile"
  // concept exists yet to default it from.
  { name: 'issuer_name', label: 'Your company name', type: 'text' },
  { name: 'issuer_address', label: 'Your company address', type: 'text', widget: 'long' },
  { name: 'issuer_phone', label: 'Your company phone', type: 'text', widget: 'phone' },
  { name: 'issuer_email', label: 'Your company email', type: 'text' },
  {
    name: 'currency',
    label: 'Currency',
    type: 'selection',
    selection: { options: ['USD', 'EUR', 'GBP'] },
  },
  { name: 'reference', label: 'Reference', type: 'text' },
  // Read-only display (TableWidget, docs/roadmaps/app-store.md Phase 2): the
  // engine has no editable-array widget yet, so Lines is real, printable
  // data (see module.go) with no in-form editor — populate via the generic
  // PUT/POST API until one exists (docs/adr/ADR-011's Consequences).
  {
    name: 'lines',
    label: 'Line items',
    type: 'text',
    widget: 'table',
    store: false,
    widgetOptions: {
      columns: [
        { key: 'description', label: 'Description' },
        { key: 'unit', label: 'Unit' },
        { key: 'quantity', label: 'Quantity' },
        { key: 'unit_price', label: 'Unit price' },
        { key: 'vat_rate', label: 'VAT' },
        { key: 'total_ht', label: 'Total (excl. tax)' },
      ],
      emptyLabel: 'No line items yet — add them via the API.',
    },
  },
  { name: 'subtotal', label: 'Subtotal (excl. tax)', type: 'number', widget: 'float' },
  { name: 'discount', label: 'Discount (excl. tax)', type: 'number', widget: 'float' },
  { name: 'net_subtotal', label: 'Net subtotal (excl. tax)', type: 'number', widget: 'float' },
  { name: 'tax_rate', label: 'Tax rate', type: 'number', widget: 'percent' },
  { name: 'tax_amount', label: 'Tax amount', type: 'number', widget: 'float' },
  { name: 'payment_method', label: 'Payment method', type: 'text' },
  { name: 'payment_terms', label: 'Payment terms', type: 'text', widget: 'long' },
  { name: 'legal_notice', label: 'Legal notice', type: 'text', widget: 'long' },
]

const dashboardView: ViewDescriptor = {
  entity: 'invoice',
  viewType: 'dashboard',
  fields,
  permissions: ['sale:invoices:read'],
}

const listView: ViewDescriptor = {
  entity: 'invoice',
  viewType: 'tree',
  fields,
  formPath: '/sale/:id',
  createPermission: 'sale:invoices:write',
  permissions: ['sale:invoices:read'],
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
  permissions: ['sale:invoices:read'],
  actions: formActions,
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
  permissions: ['sale:invoices:read'],
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
      columns: [
        { name: 'description', label: 'Description' },
        { name: 'unit', label: 'Unit' },
        { name: 'quantity', label: 'Quantity' },
        { name: 'unit_price', label: 'Unit price' },
        { name: 'vat_rate', label: 'VAT' },
        { name: 'total_ht', label: 'Total (excl. tax)' },
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
    { path: '/sale', descriptor: dashboardView, permission: 'sale:invoices:read' },
    { path: '/sale/list', descriptor: listView, permission: 'sale:invoices:read' },
    { path: '/sale/:id', descriptor: formView, permission: 'sale:invoices:read' },
  ],
  reports: [invoiceReport],
}

export default sale
