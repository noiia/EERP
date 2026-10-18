import {
  reportAddressBlock,
  reportPartyAddressFields,
  type ReportNode,
  type ReportSectionNode,
} from '@eerp/core-front'

// The components sale.quote and sale.invoice share. Both reports extend the
// engine's defaultReport ('core.default'): the letterhead header (company logo
// + address) and footer come from there, so neither prints its own issuer
// block or logo any more — only what the document itself says.

/** The document's date and number, top right under the letterhead. */
export const documentMeta: ReportSectionNode = {
  kind: 'section',
  className: 'eerp-report-doc-meta',
  children: [
    { kind: 'field', name: 'issue_date', format: 'date' },
    { kind: 'field', name: 'number' },
  ],
}

/** Who the document is for — the rent receipt's labeled address block. */
export const customerBlock: ReportSectionNode = reportAddressBlock('Customer:', [
  ...reportPartyAddressFields('customer', false),
  { kind: 'field', name: 'customer_email' },
])

/** One "Label: value" line (payment terms, due date, reference…). */
export function labeledLine(label: string, field: string, format?: 'date'): ReportSectionNode {
  return {
    kind: 'section',
    className: 'eerp-report-payment',
    children: [
      { kind: 'text', text: label, className: 'eerp-report-label' },
      { kind: 'field', name: field, format },
    ],
  }
}

/** One right-aligned "label / amount" row in the totals recap block. */
function totalsRow(label: string, field: string, grand = false): ReportNode {
  return {
    kind: 'section',
    className: grand ? 'eerp-report-totals-row eerp-report-totals-row--grand' : 'eerp-report-totals-row',
    children: [
      { kind: 'text', text: label },
      { kind: 'field', name: field, format: 'number' },
    ],
  }
}

/** The excl. tax / tax / incl. tax recap under the lines. */
export const totalsSection: ReportSectionNode = {
  kind: 'section',
  className: 'eerp-report-totals',
  children: [
    totalsRow('Subtotal (excl. tax)', 'subtotal'),
    totalsRow('Tax', 'tax_amount'),
    totalsRow('Total (incl. tax)', 'total', true),
  ],
}

/** The legal notice, last on the page. */
export const legalNotice: ReportSectionNode = {
  kind: 'section',
  className: 'eerp-report-footer',
  children: [{ kind: 'field', name: 'legal_notice' }],
}
