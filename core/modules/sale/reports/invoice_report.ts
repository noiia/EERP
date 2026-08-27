import { reportPartyAddressFields, reportTitleSection, type ReportDescriptor } from '@eerp/core-front'

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
export const invoiceReport: ReportDescriptor = {
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
    // SAMPLE — demonstrates the two halves of adding CSS to a module's own
    // report (a module can't ship its own CSS file; report.css is the one
    // shared, root-layout-imported stylesheet every ReportNode.className
    // reaches into — see the className mechanics doc comment at the top of
    // report-descriptor.ts). The outer section and the "Reference:" label
    // both INHERIT existing classes (eerp-report-payment/-label, unchanged);
    // eerp-report-reference-badge is a brand-new rule added to report.css
    // just for this field. Not load-bearing — delete this section freely.
    {
      kind: 'section',
      className: 'eerp-report-payment',
      children: [
        { kind: 'text', text: 'Reference:', className: 'eerp-report-label' },
        { kind: 'field', name: 'reference', className: 'eerp-report-reference-badge' },
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
