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
