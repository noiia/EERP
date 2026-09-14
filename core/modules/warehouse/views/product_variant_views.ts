import { type FrontRoute, type ViewDescriptor } from '@eerp/core-front'

// product_variant — the concrete, sellable thing a sale.SaleLine actually
// points at (see core/modules/warehouse/module.go's doc comments).

export interface ProductVariant {
  id: string
  tenant_id: string
  product_id: string
  name: string
  /** Overrides the parent Product's unit_price for this variant when set. */
  unit_price?: number | null
  /** Overrides the parent Product's tax_rate for this variant when set. */
  tax_rate?: number | null
}

const variantFields: ViewDescriptor['fields'] = [
  {
    name: 'product_id',
    label: 'Product',
    type: 'relation',
    required: true,
    relation: { entity: 'product', kind: 'many2one', labelField: 'name' },
  },
  // Not required: a blank Name is auto-filled from the product's own name by
  // the backend's Create override (core/modules/warehouse/handler.go) — "each
  // product automatically references a variant."
  { name: 'name', label: 'Name', type: 'text' },
  // Optional: blank means "inherit the product's own price." When set, sale's
  // snapshotFromVariant (core/modules/sale/handler.go and quote_handler.go)
  // uses this instead of the product's unit_price for lines on this variant.
  // default: null overrides the number type's usual zero-default (a new
  // variant seeded with 0 would silently price every sale line at zero).
  { name: 'unit_price', label: 'Price override (excl. tax)', type: 'number', widget: 'float', default: null },
  // Optional: blank means "inherit the product's own tax rate," same
  // override contract as unit_price above. default: null for the same
  // reason — a new variant seeded with 0 would silently zero-rate every
  // sale line on it.
  { name: 'tax_rate', label: 'Tax rate override', type: 'number', widget: 'percent', default: null },
]

const variantListView: ViewDescriptor = {
  entity: 'product_variant',
  viewType: 'tree',
  fields: variantFields,
  formPath: '/warehouse/variants/:id',
  createPermission: 'product_variant:product_variant:write',
  permissions: ['product_variant:product_variant:read'],
}

const variantFormView: ViewDescriptor = {
  entity: 'product_variant',
  viewType: 'form',
  fields: variantFields,
  permissions: ['product_variant:product_variant:read'],
}

export const productVariantRoutes: FrontRoute[] = [
  {
    path: '/warehouse/variants/list',
    descriptor: variantListView,
    permission: 'product_variant:product_variant:read',
  },
  {
    path: '/warehouse/variants/:id',
    descriptor: variantFormView,
    permission: 'product_variant:product_variant:read',
  },
]
