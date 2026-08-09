import type { FrontModule, ViewDescriptor } from '@eerp/core-front'

// warehouse frontend — DESCRIPTORS ONLY (same discipline as core/modules/crm's
// CrmViews.ts). Two entities, one module: `product` (the catalog entry) and
// `product_variant` (the concrete, sellable thing a sale.SaleLine actually
// points at — see core/modules/warehouse/module.go's doc comments). Both map
// 1:1 to their Go route prefix; field names match the DB column names the
// handler returns, and permission strings mirror the route:
// <table>:<table>:<action>.

export interface Product {
  id: string
  tenant_id: string
  name: string
  reference?: string
  unit?: string
  unit_price?: number
  tax_rate?: number
}

export interface ProductVariant {
  id: string
  tenant_id: string
  product_id: string
  name: string
}

const productFields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'reference', label: 'Reference', type: 'text' },
  { name: 'unit', label: 'Unit', type: 'text' },
  { name: 'unit_price', label: 'Unit price (excl. tax)', type: 'number', widget: 'float' },
  { name: 'tax_rate', label: 'Tax rate', type: 'number', widget: 'percent' },
]

// Form-only: every ProductVariant referencing this product, embedded
// read-only (same relation/list pattern as contact's crm_records) — makes
// "once one is created, the original stays referenced, and the variant
// exists" (module.go's doc comment) visible: a product's own form shows
// whichever variant(s) already exist for it.
const productFormFields: ViewDescriptor['fields'] = [
  ...productFields,
  {
    name: 'variants',
    label: 'Variants',
    type: 'relation',
    relation: { entity: 'product_variant', kind: 'one2many', inverseField: 'product_id', labelField: 'name' },
  },
]

const productListView: ViewDescriptor = {
  entity: 'product',
  viewType: 'tree',
  fields: productFields,
  formPath: '/warehouse/products/:id',
  createPermission: 'product:product:write',
  permissions: ['product:product:read'],
}

const productFormView: ViewDescriptor = {
  entity: 'product',
  viewType: 'form',
  fields: productFormFields,
  permissions: ['product:product:read'],
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

// The app's landing page: ONE dashboard route, two tiles. The engine rolls
// every 'tree' viewType route this module owns into one count-card each
// (apps/shell/app/[...module]/resolve.ts's dashboardListViews, over
// ModuleRegistry.listViews) — so registering both entities' list views below
// is what actually produces the Product / Product Variant tiles; nothing
// here names them directly. Click-through is the engine's own click ->
// href="{list path}" -> row click -> formPath wiring, same as any tree view.
// `entity: 'product'` is a required-but-unused-here field (DashboardRenderer
// only reads the widgets built from the two tree views, not this one).
const dashboardView: ViewDescriptor = {
  entity: 'product',
  viewType: 'dashboard',
  fields: productFields,
  permissions: ['product:product:read'],
}

const warehouse: FrontModule = {
  name: 'warehouse',
  routes: [
    { path: '/warehouse', descriptor: dashboardView, permission: 'product:product:read' },
    { path: '/warehouse/products/list', descriptor: productListView, permission: 'product:product:read' },
    { path: '/warehouse/products/:id', descriptor: productFormView, permission: 'product:product:read' },
    {
      path: '/warehouse/variants/list',
      descriptor: variantListView,
      permission: 'product_variant:product_variant:read',
    },
    { path: '/warehouse/variants/:id', descriptor: variantFormView, permission: 'product_variant:product_variant:read' },
  ],
}

export default warehouse
