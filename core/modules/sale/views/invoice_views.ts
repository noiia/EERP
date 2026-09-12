import {
  exportReportPDF,
  FORM_NOTEBOOK_ID,
  registerFieldFunction,
  registerMenuAction,
  type FrontRoute,
  type MenuNode,
  type Operation,
  type ViewDescriptor,
} from '@eerp/core-front'

// invoice — the billing document. Every `entity` name is the Go route
// prefix from module.go's orm.Register calls — NOT the module slug 'sale'.

/** The Invoice record as served by Go's /invoice endpoints (BaseModel + business fields). */
export interface Invoice {
  id: string
  /** true ⇔ a picture exists on this record's logo anchor (picture service). */
  logo?: boolean | null
  issuer_name?: string
  // issuer_address_* — the type: 'address' composite field's 7 sibling
  // columns (core-front's AddressWidget). Never edited on the invoice form
  // itself (see formFields below) — blank falls back to the active
  // company's own address at print time (reports/invoice_report.ts's
  // companyFallback).
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
  /** The quote this invoice was created FROM (quote_views.ts's
   * sale.acceptQuote header button handler) — null for an invoice raised
   * directly, never through a quote's Accept flow. */
  quote_id?: string | null
  subtotal?: number | null
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

// sale.printInvoice — the invoice form's Print > Invoice menu action
// (docs/adr/ADR-011), reusing the exact "call the BFF, open the PDF" logic
// the old ReportExportButton had (exportReportPDF, engine-shared) rather than
// duplicating the fetch dance here.
registerMenuAction({
  entity: 'invoice',
  name: 'sale.printInvoice',
  handler: ({ recordId }) => exportReportPDF('sale.invoice', recordId),
})

export const fields: ViewDescriptor['fields'] = [
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
  // System-set provenance link, never hand-picked: quote_views.ts's
  // sale.acceptQuote is the only writer, at invoice-creation time. readOnly
  // rather than omitted from the form entirely — a user should be able to
  // SEE which quote (if any) an invoice came from.
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
// self-extension shape core/modules/crm/views/crm_views.ts uses for its
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
export const orderLinesPageOperations: Operation[] = [
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

// Routes this file contributes to sale_views.ts's assembled FrontModule.
// dashboardRoute is exported SEPARATELY from the rest and must stay FIRST in
// the module's overall routes array: Menu.tsx's landing tile links to
// `module.routes[0].path`, so the module's dashboard has to be that first
// entry regardless of which entity file's routes sale_views.ts otherwise
// lists first (quote's, for the tree-view tile-ordering reason documented
// on quote_views.ts's own quoteRoutes).
export const dashboardRoute: FrontRoute = {
  path: '/sale',
  descriptor: dashboardView,
  permission: 'invoice:invoice:read',
}

export const invoiceRoutes: FrontRoute[] = [
  { path: '/sale/list', descriptor: listView, permission: 'invoice:invoice:read' },
  { path: '/sale/:id', descriptor: formView, permission: 'invoice:invoice:read' },
]
