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
// active company profile, never the record. `groupCountryWithCity: true`
// (opt-in, this report only) puts the issuer's zip/city/country on ONE row
// instead of country on its own line below — a plain locale convention
// choice, scoped so it can't change how sale's invoice/quote issuer block
// prints its own address. Top-right stays the property/tenant(s) snapshot
// this entity actually has — a flat address string (formatPropertyAddress's
// FULL line, not just number+street — the earlier truncation was why a
// generated report read "barely empty") plus floor_area and a comma-joined
// tenant list, not the 7-column composite (no per-tenant address exists to
// decompose: tenants live at the property's own address); its own
// eerp-report-client--pm class LEFT-aligns it (report.css) — the shared
// eerp-report-client rule it also carries right-aligns text for sale's own
// masthead-column client block, wrong once this section moved to a
// full-width block of its own (see the layout below). The title is a STATIC
// bigger label, not `reportTitleSection` over a record field — the receipt
// form has no writable field at all (handler.go rejects every PUT/DELETE;
// the document is append-only), so there is no field here a user could ever
// "edit manually later". rent_price is no longer its own headline block —
// it prints as the billing-lines table's own FIRST row instead (a "Rent"
// line, property_management_views.ts's generateRentReceipt creates it
// report-only, ahead of the copied billing lines — the property's own
// rent_price field is untouched by this). The table itself (module.go's
// PropertyManagementRentReceiptLine, a generation-time snapshot copy of the
// property's own billing lines) and a totals recap use the same
// eerp-report-table / eerp-report-totals styling and structure as sale's own
// invoice_report.ts.
export const rentReceiptReport: ReportDescriptor = {
  name: 'propertymanagement.rentReceipt',
  entity: 'property_management_rent_receipt',
  permissions: ['property_management_rent_receipt:property_management_rent_receipt:read'],
  layout: [
    {
      kind: 'section',
      className: 'eerp-report-parties',
      children: [
        {
          // eerp-report-issuer--pm is a SECOND, additive class (not a
          // replacement) — the base eerp-report-issuer rule in report.css
          // still applies (font/layout shared with every other report), this
          // one just layers property management's own look on top. Scoping
          // it this way means tweaking it can't accidentally change how
          // sale's invoice/quote issuer block prints.
          kind: 'section',
          className: 'eerp-report-issuer eerp-report-issuer--pm',
          children: reportPartyAddressFields('issuer', true, { groupCountryWithCity: true }),
        },
        {
          kind: 'section',
          children: [
            { kind: 'text', text: 'Tenant(s):', className: 'eerp-report-label' },
            { kind: 'field', name: 'tenant_names', className: 'eerp-report-tenant-names' },
          ]
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
