import { type FrontRoute, type ViewDescriptor } from '@eerp/core-front'

// sale_line — a line item snapshotted from a product.variant, one row per
// invoice line (core/modules/sale/module.go's SaleLine).

/** One sale_line row — a line item snapshotted from a product.variant. */
export interface SaleLine {
  id: string
  invoice_id: string
  variant_id: string
  variant_name?: string
  quantity: number
  unit?: string
  /** 0..1 ratio, snapshotted from the product; the percent widget displays it ×100. */
  tax_rate?: number
  unit_price?: number
  /** Server-computed final price — quantity × unit_price, plus tax_rate
   * above, plus every tag in `taxes` below (percentage or fixed) — see
   * core/modules/sale/handler.go's computeLineTotal. Whether this already
   * has tax baked in or tax sits on top of quantity×unit_price depends on
   * the workspace's Settings -> Tax price mode. Never hand-typed. */
  total?: number
  /** Server-computed tax-EXCLUDED contribution — always quantity×unit_price
   * when the workspace prices tax_excluded, but back-derived from total
   * when tax_included. Never hand-typed; not shown on the form (total is
   * what the user cares about), only read by the invoice's own Subtotal
   * rollup (handler.go's sumLines). */
  subtotal?: number
}

// sale_line's own descriptor — needed so the invoice form's one2many
// create-wizard (RelationListWidget/RelationCreateWizard) has a form to
// render: invoice_id is preset+hidden by the wizard's context (same
// contact.crm_records/contact_id pattern), variant_id is the line's real
// "product.variant many2one" first column, and unit/tax_rate/unit_price are
// read-only because the backend snapshots them from the chosen variant's
// product (core/modules/sale/handler.go) — never hand-typed.
const saleLineFields: ViewDescriptor['fields'] = [
  {
    name: 'invoice_id',
    label: 'Invoice',
    type: 'relation',
    required: true,
    relation: { entity: 'invoice', kind: 'many2one', labelField: 'number' },
  },
  {
    name: 'variant_id',
    label: 'Product variant',
    type: 'relation',
    required: true,
    relation: { entity: 'product_variant', kind: 'many2one', labelField: 'name' },
  },
  { name: 'quantity', label: 'Quantity', type: 'number', required: true },
  { name: 'unit', label: 'Unit', type: 'text', readOnly: true },
  { name: 'tax_rate', label: 'Tax', type: 'number', widget: 'percent', readOnly: true },
  { name: 'unit_price', label: 'Unit price (excl. tax)', type: 'number', widget: 'float', readOnly: true },
  // Extra taxes, stacked on top of tax_rate above (module.go's SaleLine.Total
  // doc comment) — junction is sale_line_tax, hand-mounted Create/Delete
  // (handler.go) so tagging/untagging recomputes total below.
  {
    name: 'taxes',
    label: 'Taxes',
    type: 'relation',
    relation: { entity: 'sale_tax', kind: 'many2many', via: 'sale_line_tax', labelField: 'name' },
  },
  { name: 'total', label: 'Total', type: 'number', widget: 'monetary', readOnly: true },
]

const saleLineFormView: ViewDescriptor = {
  entity: 'sale_line',
  viewType: 'form',
  fields: saleLineFields,
  permissions: ['sale_line:sale_line:read'],
}

export const saleLineRoutes: FrontRoute[] = [
  { path: '/sale/lines/:id', descriptor: saleLineFormView, permission: 'sale_line:sale_line:read' },
]
