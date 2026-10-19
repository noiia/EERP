import { DEFAULT_REPORT_NAME, reportTitleSection, type ReportDescriptor } from '@eerp/core-front'
import { customerBlock, documentMeta, labeledLine, legalNotice, totalsSection } from './document_parts'

// sale.invoice — the invoice's printable PDF (Print > Invoice, and the
// attachment Send emails), a standard letterhead invoice: the letterhead
// header (company logo + address) and footer from the default report it
// extends, then date + number, the Customer block, a subject line, a bordered
// item table, a right-aligned excl. tax / tax / incl. tax recap and the small
// print. className hooks come from apps/shell/app/print/report/report.css.
export const invoiceReport: ReportDescriptor = {
  name: 'sale.invoice',
  extends: DEFAULT_REPORT_NAME,
  entity: 'invoice',
  permissions: ['invoice:invoice:read'],
  layout: [
    documentMeta,
    customerBlock,
    reportTitleSection('subject'),
    {
      kind: 'section',
      className: 'eerp-report-payment',
      children: [
        { kind: 'text', text: 'Reference:', className: 'eerp-report-label' },
        // eerp-report-reference-badge (report.css): a light pill around the
        // customer's PO/reference number.
        { kind: 'field', name: 'reference', className: 'eerp-report-reference-badge' },
      ],
    },
    {
      kind: 'table',
      source: 'lines',
      className: 'eerp-report-table',
      relation: { entity: 'sale_line', inverseField: 'invoice_id' },
      columns: [
        { name: 'variant_name', label: 'Product' },
        { name: 'quantity', label: 'Quantity' },
        { name: 'unit_price', label: 'Unit price' },
        { name: 'tax_rate', label: 'Tax' },
        { name: 'total', label: 'Total' },
      ],
    },
    totalsSection,
    labeledLine('Payment method:', 'payment_method'),
    labeledLine('Payment terms:', 'payment_terms'),
    labeledLine('Due date:', 'due_date', 'date'),
    legalNotice,
  ],
}
