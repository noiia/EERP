import { reportPartyAddressFields, type ReportDescriptor } from '@eerp/core-front'

/** One right-aligned "label / amount" row in the totals recap block — same shape as sale/reports/invoice_report.ts's own totalsRow. */
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

// propertymanagement.rentReceipt — the receipt's own printable PDF, rendered
// once at generation time (property_management_rent_receipt_views.ts's
// Regenerate PDF header button, and property_management_views.ts's Generate
// Rent Receipt) and never again — the bytes this produces are what get
// re-uploaded onto the receipt's own receipt_file anchor, so a later
// download always shows exactly what was true when it was generated. Adopts
// the default report masthead (report-descriptor.ts's
// reportPartyAddressFields): the issuing company's address top-left, PURE
// companyFallback — the receipt itself has no issuer_* columns of its own
// (there's only ever one party issuing a rent receipt: the printing user's
// active company), so every one of those fields resolves entirely from the
// active company profile, never the record. Top-right stays the
// property/tenant(s) snapshot this entity actually has — a flat address
// string (formatPropertyAddress's FULL line, not just number+street — the
// earlier truncation was why a generated report read "barely empty") plus
// floor_area and a comma-joined tenant list, not the 7-column composite (no
// per-tenant address exists to decompose: tenants live at the property's
// own address). The title is a STATIC bigger label, not `reportTitleSection`
// over a record field — the receipt form has no writable field at all
// (handler.go rejects every PUT/DELETE; the document is append-only), so
// there is no field here a user could ever "edit manually later". rent_price
// prints right under the title, ahead of everything else — the receipt's
// single most important figure — then the billing-lines table (module.go's
// PropertyManagementRentReceiptLine, a generation-time snapshot copy of the
// property's own billing lines) and a totals recap, same eerp-report-table /
// eerp-report-totals styling and structure as sale's own invoice_report.ts.
export const rentReceiptReport: ReportDescriptor = {
  name: 'propertymanagement.rentReceipt',
  entity: 'property_management_rent_receipt',
  permissions: ['property_management_rent_receipt:property_management_rent_receipt:read'],
  layout: [
    {
      kind: 'section',
      className: 'eerp-report-parties',
      children: [
        { kind: 'section', className: 'eerp-report-issuer', children: reportPartyAddressFields('issuer', true) },
        {
          kind: 'section',
          className: 'eerp-report-client',
          children: [
            { kind: 'text', text: 'Tenant(s):', className: 'eerp-report-label' },
            { kind: 'field', name: 'tenant_names' },
            { kind: 'text', text: 'Property:', className: 'eerp-report-label' },
            { kind: 'field', name: 'property_name' },
            { kind: 'field', name: 'property_address' },
            { kind: 'field', name: 'floor_area', format: 'number' },
          ],
        },
      ],
    },
    { kind: 'text', text: 'Rent receipt', className: 'eerp-report-title' },
    {
      kind: 'section',
      className: 'eerp-report-doc-meta',
      children: [
        { kind: 'field', name: 'period' },
        { kind: 'field', name: 'generated_at', format: 'date' },
      ],
    },
    // The headline figure, printed big and first — ahead of the table it's
    // NOT part of (rent_price is the apartment's own monthly rent, a plain
    // property figure; the billing lines below are what's actually charged
    // this period, which may include the rent line plus others).
    {
      kind: 'section',
      className: 'eerp-report-payment',
      children: [
        { kind: 'text', text: 'Rent price:', className: 'eerp-report-label' },
        { kind: 'field', name: 'rent_price', format: 'number', className: 'eerp-report-title' },
      ],
    },
    {
      kind: 'table',
      source: 'lines',
      className: 'eerp-report-table',
      // property_management_rent_receipt_line rows live in their own table
      // (module.go) — the print route fetches them (filtered by
      // rent_receipt_id) and assigns them onto record.lines before this node
      // renders, same relation mechanic as sale.invoice's own 'lines' table
      // (report-descriptor.ts's ReportTableNode.relation doc comment).
      relation: { entity: 'property_management_rent_receipt_line', inverseField: 'rent_receipt_id' },
      columns: [
        { name: 'name', label: 'Description' },
        { name: 'unit_price', label: 'Price' },
        { name: 'tax_rate', label: 'Tax' },
        // Copied verbatim from the source billing line at generation time —
        // already server-computed (propertymanagement/handler.go's
        // computeBillingLineTotal). See module.go's
        // PropertyManagementRentReceiptLine.Total doc comment.
        { name: 'total', label: 'Total' },
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
  ],
}
