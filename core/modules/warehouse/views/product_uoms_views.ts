import { type FrontRoute, type ViewDescriptor } from '@eerp/core-front'

// product_uoms — the unit-of-measure catalog (piece/length/weight/volume/
// surface/custom) picked by other modules' many2one fields (e.g.
// propertymanagement.PropertyManagement.uom_id, for FloorArea). `type` is
// what a picker filters on — see core/modules/warehouse/module.go's
// ProductUoms doc comments. Registering a real form here (rather than
// leaving the entity formless) is what makes the many2one's quick-create
// wizard show `type`, not just `name` — RelationCreateWizard falls back to a
// bare labelField text input for any entity with no registered form
// (core-front/.../views/relation-widgets.tsx's creationDescriptor). Every
// tenant starts with a basic metric+imperial catalog already seeded —
// module.go's seedDefaultUoms, keyed by these SAME type strings.

export interface ProductUoms {
  id: string
  tenant_id: string
  name: string
  type: string
  /** The short printable unit symbol ("m²", "ft²", "kg", ...) — what a
   * report prints next to a value, as opposed to `name`, the picker's own
   * human-readable label ("Square meter (m²)"). */
  symbol: string
}

const uomFields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'symbol', label: 'Symbol', type: 'text', required: true },
  {
    name: 'type',
    label: 'Type',
    type: 'selection',
    required: true,
    selection: { options: ['piece', 'length', 'weight', 'volume', 'surface', 'custom'] },
  },
]

const uomListView: ViewDescriptor = {
  entity: 'product_uoms',
  viewType: 'tree',
  fields: uomFields,
  formPath: '/warehouse/uoms/:id',
  createPermission: 'product_uoms:product_uoms:write',
  permissions: ['product_uoms:product_uoms:read'],
}

const uomFormView: ViewDescriptor = {
  entity: 'product_uoms',
  viewType: 'form',
  fields: uomFields,
  permissions: ['product_uoms:product_uoms:read'],
}

export const productUomsRoutes: FrontRoute[] = [
  {
    path: '/warehouse/uoms/list',
    descriptor: uomListView,
    permission: 'product_uoms:product_uoms:read',
  },
  {
    path: '/warehouse/uoms/:id',
    descriptor: uomFormView,
    permission: 'product_uoms:product_uoms:read',
  },
]
