import { type FrontRoute, type ViewDescriptor } from '@eerp/core-front'

// property_management_billing_line — one billable line on a property (the
// apartment's own rent, condominium fees, an accrual for expenses, etc.),
// core/modules/propertymanagement/module.go's PropertyManagementBillingLine.
// Unlike sale_line/quote_line, there's no product/variant to snapshot from
// and no quantity concept — a line is priced as a flat whole, entered
// directly by the user.

/** One property_management_billing_line row. */
export interface PropertyManagementBillingLine {
  id: string
  property_management_id: string
  name: string
  /** Free of taxes (excl. tax) — same convention as sale_line's own unit_price. */
  unit_price?: number
  /** Legacy free-typed rate — no longer editable through the form (see
   * billingLineFields below); real tax now comes exclusively from `taxes`,
   * picked from the taxes table. Still read server-side for a pre-existing
   * line that has one (module.go's computeBillingLineTotal stacks it
   * additively, unchanged), so it stays in this type for completeness. */
  tax_rate?: number
  /** Server-computed final price — unit_price plus tax_rate above, plus
   * every tag in `taxes` below (percentage or fixed) — see
   * core/modules/propertymanagement/handler.go's computeBillingLineTotal.
   * Whether this already has tax baked in or tax sits on top of unit_price
   * depends on the workspace's Settings -> Tax price mode. Never
   * hand-typed. */
  total?: number
  /** Server-computed tax-EXCLUDED contribution — always unit_price when the
   * workspace prices tax_excluded, but back-derived from total when
   * tax_included. Never hand-typed; not shown on the form (total is what
   * the user cares about), only read by generateRentReceipt's own rollup
   * (property_management_views.ts). */
  subtotal?: number
}

// property_management_billing_line's own descriptor — needed so the
// property form's one2many create-wizard (RelationListWidget/
// RelationCreateWizard) has a form to render: property_management_id is
// preset+hidden by the wizard's context (same invoice_id/quote_id pattern
// sale_line/quote_line use), name/unit_price are plain editable fields —
// nothing here is a server-side snapshot. Tax is picked from the taxes
// table (the `taxes` many2many below) rather than freely typed — the old
// plain tax_rate percent field is gone from this form on purpose (by
// design, not an oversight): it let anyone type an arbitrary, ungoverned
// rate instead of choosing a real, named SaleTax row. Go still reads it
// server-side for a pre-existing line that already has one (see the
// PropertyManagementBillingLine.tax_rate type's own doc comment) and keeps
// stacking it additively into Total — this form just never writes it again.
const billingLineFields: ViewDescriptor['fields'] = [
  {
    name: 'property_management_id',
    label: 'Property',
    type: 'relation',
    required: true,
    relation: { entity: 'property_management', kind: 'many2one', labelField: 'name' },
  },
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'unit_price', label: 'Price (excl. tax)', type: 'number', widget: 'float' },
  // Junction is property_management_billing_line_tax, hand-mounted
  // Create/Delete (handler.go) so tagging/untagging recomputes total below.
  // Same shared sale_tax entity sale_line's own `taxes` field points at
  // (sale_line_views.ts) — one tax catalog for every module.
  {
    name: 'taxes',
    label: 'Taxes',
    type: 'relation',
    relation: { entity: 'sale_tax', kind: 'many2many', via: 'property_management_billing_line_tax', labelField: 'name' },
  },
  { name: 'total', label: 'Total', type: 'number', widget: 'monetary', readOnly: true },
]

const billingLineFormView: ViewDescriptor = {
  entity: 'property_management_billing_line',
  viewType: 'form',
  fields: billingLineFields,
  permissions: ['property_management_billing_line:property_management_billing_line:read'],
}

export const billingLineRoutes: FrontRoute[] = [
  {
    path: '/propertymanagement/billing-lines/:id',
    descriptor: billingLineFormView,
    permission: 'property_management_billing_line:property_management_billing_line:read',
  },
]
