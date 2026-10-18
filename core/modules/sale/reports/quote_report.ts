import { DEFAULT_REPORT_NAME, reportTitleSection, type ReportDescriptor } from '@eerp/core-front'
import { customerBlock, documentMeta, labeledLine, legalNotice, totalsSection } from './document_parts'

// sale.quote — the quote's printable PDF (Print > Quote, and the attachment
// Send emails). Extends the default report: letterhead header + footer from
// there, the quote's own components here.
export const quoteReport: ReportDescriptor = {
  name: 'sale.quote',
  extends: DEFAULT_REPORT_NAME,
  entity: 'quote',
  permissions: ['quote:quote:read'],
  layout: [
    documentMeta,
    customerBlock,
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
    totalsSection,
    labeledLine('Payment method:', 'payment_method'),
    labeledLine('Payment terms:', 'payment_terms'),
    labeledLine('Valid until:', 'due_date', 'date'),
    legalNotice,
  ],
}
