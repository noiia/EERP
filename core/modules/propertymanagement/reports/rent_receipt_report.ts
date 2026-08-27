import { reportPartyAddressFields, type ReportDescriptor } from '@eerp/core-front'

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
// there is no field here a user could ever "edit manually later". No table
// node: no line items exist on this entity.
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
  ],
}
