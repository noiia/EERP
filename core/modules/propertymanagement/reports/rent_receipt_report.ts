import type { ReportDescriptor } from '@eerp/core-front'

/** One right-aligned "label / amount" row in the totals recap block — `format:
 * 'monetary'` prints the active company's own currency code alongside the
 * figure (report-renderer.tsx reads it off the record's own `currency`
 * field, set by the print route from the same active company the header's
 * logo/address already come from). */
function totalsRow(label: string, field: string, grand = false): ReportDescriptor['layout'][number] {
  return {
    kind: 'section',
    className: grand ? 'eerp-report-totals-row eerp-report-totals-row--grand' : 'eerp-report-totals-row',
    children: [
      { kind: 'text', text: label },
      { kind: 'field', name: field, format: 'monetary' },
    ],
  }
}

// propertymanagement.rentReceipt — the receipt's own printable PDF, rendered
// once at generation time (property_management_rent_receipt_views.ts's
// Regenerate PDF header button, and property_management_views.ts's Generate
// Rent Receipt) and never again — the bytes this produces are what get
// re-uploaded onto the receipt's own receipt_file anchor, so a later
// download always shows exactly what was true when it was generated. No
// issuer/company block of its own: the printing company's own details
// (address + logo) now print in the print route's own document header
// (page.tsx's eerp-report-chrome-header, above EVERY report's content) —
// the receipt has no issuer_* columns to begin with (there's only ever one
// party issuing a rent receipt: the printing user's active company), so a
// bespoke reportPartyAddressFields block here would only have ever
// duplicated that same chrome. What prints instead is the property/
// tenant(s) snapshot this entity actually has — a flat address string
// (formatPropertyAddress's FULL line, not just number+street — the earlier
// truncation was why a generated report read "barely empty") plus
// floor_area and a comma-joined tenant list, not the 7-column composite (no
// per-tenant address exists to decompose: tenants live at the property's own
// address); its own eerp-report-client--pm class LEFT-aligns it (report.css)
// — the shared eerp-report-client rule it also carries right-aligns text for
// sale's own masthead-column client block, wrong once this section moved to
// a full-width block of its own (see the layout below). The title is a
// STATIC bigger label, not `reportTitleSection` over a record field — the
// receipt form has no writable field at all (handler.go rejects every
// PUT/DELETE; the document is append-only), so there is no field here a
// user could ever "edit manually later". rent_price is no longer its own
// headline block — it prints as the billing-lines table's own FIRST row
// instead (a "Rent" line, property_management_views.ts's generateRentReceipt
// creates it report-only, ahead of the copied billing lines — the
// property's own rent_price field is untouched by this). The table itself
// (module.go's PropertyManagementRentReceiptLine, a generation-time
// snapshot copy of the property's own billing lines) and a totals recap use
// the same eerp-report-table / eerp-report-totals styling and structure as
// sale's own invoice_report.ts.
export const rentReceiptReport: ReportDescriptor = {
  name: 'propertymanagement.rentReceipt',
  entity: 'property_management_rent_receipt',
  permissions: ['property_management_rent_receipt:property_management_rent_receipt:read'],
  layout: [
    {
      kind: 'section',
      children: [
        { kind: 'text', text: 'Tenant(s):', className: 'eerp-report-label' },
        { kind: 'field', name: 'tenant_names', className: 'eerp-report-tenant-names' },
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
    {
      kind: 'section',
      className: 'eerp-report-client eerp-report-client--pm',
      children: [
        { kind: 'text', text: 'Property:', className: 'eerp-report-label' },
        { kind: 'field', name: 'property_name' },
        { kind: 'field', name: 'property_address' },
        {
          kind: 'section',
          className: 'eerp-pm-report-property',
          children: [
            { kind: 'field', name: 'floor_area', format: 'number' },
            { kind: 'field', name: 'uom'},
          ]
        }
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
        // The source billing line's own `taxes` many2many, resolved to a
        // printable "name (rate%)" label at generation time
        // (property_management_views.ts's resolveLineTaxLabel) — the
        // now-unused TaxRate scalar's replacement (module.go's own doc
        // comment on PropertyManagementRentReceiptLine.TaxRate/TaxLabel).
        { name: 'tax_label', label: 'Tax' },
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
