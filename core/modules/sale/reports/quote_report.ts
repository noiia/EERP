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

// sale.quote — the quote's own printable PDF, triggered by quote_views.ts's
// Send header button (sale.sendQuote). Mirrors reports/invoice_report.ts
// field-for-field (same letterhead template — Quote's own doc comment in
// module.go), scoped to quote/quote_line instead of invoice/sale_line; the
// only textual difference is "Valid until:" instead of "Due date:", matching
// the form's own due_date label ("Valid until" — a quote's due_date is an
// expiry, not a payment deadline).
export const quoteReport: ReportDescriptor = {
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
      // Same masthead composition as reports/invoice_report.ts (report-
      // descriptor.ts's reportPartyAddressFields, plus issuer/customer's
      // own phone/email lines).
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
