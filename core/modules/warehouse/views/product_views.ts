import { FORM_COLUMNS_ID, FORM_HEADER_ID, type FrontRoute, type ViewDescriptor } from '@eerp/core-front'

// product — the catalog entry (see core/modules/warehouse/module.go's doc
// comments). Field names match the DB column names the handler returns,
// and permission strings mirror the route: product:product:<action>.

export interface Product {
  id: string
  tenant_id: string
  name: string
  reference?: string
  unit_price?: number
  picture?: boolean | null
}

const productFields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  // Automatic by default: Go fills it from the product sequence (PRD-00001)
  // and keeps it, and the field is read-only while the warehouse setting
  // auto_reference is on — the form reads that setting as its context
  // (formContext below). Off, the user types it.
  {
    name: 'reference',
    label: 'Reference',
    type: 'text',
    states: { readOnly: { field: 'context.auto_reference', op: 'eq', value: true } },
  },
  { name: 'unit_price', label: 'Unit price (excl. tax)', type: 'number', widget: 'float' },
  // No single tax rate any more: a product's taxes are the sale module's
  // Taxes field (product_tax), added to this form by sale_views.ts.
]

// Form-only: every ProductVariant referencing this product, embedded
// read-only (same relation/list pattern as contact's crm_records) — makes
// "once one is created, the original stays referenced, and the variant
// exists" (module.go's doc comment) visible: a product's own form shows
// whichever variant(s) already exist for it.
const productFormFields: ViewDescriptor['fields'] = [
  { name: 'picture', label: 'Picture', type: 'boolean', widget: 'picture', hideLabel: true },
  ...productFields,
  // The unit the product is sold in (product_uoms): a sale line takes it as
  // its own unit unless it picks another (sale's resolveLineUnit).
  {
    name: 'uom_id',
    label: 'Unit of measure',
    type: 'relation',
    relation: { entity: 'product_uoms', kind: 'many2one', labelField: 'name' },
  },
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
  // The warehouse settings: auto_reference makes the reference read-only.
  formContext: '/settings/warehouse',
  // Same header/two-column body the default anatomy would synthesize, EXCEPT
  // 'variants' is pulled into its own full-width group after the columns —
  // a relation table cramped into a 50%-width column reads worse than the
  // stock two-up layout the other (scalar) fields still get.
  layout: [
    // The picture on top, beside the name.
    {
      kind: 'row',
      id: FORM_HEADER_ID,
      children: [
        { kind: 'field', name: 'picture' },
        { kind: 'field', name: 'name', variant: 'title' },
      ],
    },
    {
      kind: 'group',
      id: FORM_COLUMNS_ID,
      columns: 2,
      children: [
        { kind: 'field', name: 'reference' },
        { kind: 'field', name: 'unit_price' },
        { kind: 'field', name: 'uom_id' },
      ],
    },
    { kind: 'group', id: 'variants_group', children: [{ kind: 'field', name: 'variants' }] },
  ],
}

// The app's landing page: ONE dashboard route, two tiles. The engine rolls
// every 'tree' viewType route this module owns into one count-card each
// (apps/shell/app/[...module]/resolve.ts's dashboardListViews, over
// ModuleRegistry.listViews) — so registering both entities' list views is
// what actually produces the Product / Product Variant tiles; nothing here
// names them directly. Click-through is the engine's own click ->
// href="{list path}" -> row click -> formPath wiring, same as any tree view.
// `entity: 'product'` is a required-but-unused-here field (DashboardRenderer
// only reads the widgets built from the two tree views, not this one).
const dashboardView: ViewDescriptor = {
  entity: 'product',
  viewType: 'dashboard',
  fields: productFields,
  permissions: ['product:product:read'],
}

// Routes this file contributes to warehouse_views.ts's assembled
// FrontModule. dashboardRoute is exported SEPARATELY and must stay FIRST in
// the module's overall routes array: Menu.tsx's landing tile links to
// `module.routes[0].path`. productRoutes (the tree view) must stay
// registered BEFORE product_variant_views.ts's own tree route — the
// dashboard rolls tree-view routes into tiles in registration order, and
// Product's tile comes before Product Variant's.
export const dashboardRoute: FrontRoute = {
  path: '/warehouse',
  descriptor: dashboardView,
  permission: 'product:product:read',
}

export const productRoutes: FrontRoute[] = [
  { path: '/warehouse/products/list', descriptor: productListView, permission: 'product:product:read' },
  { path: '/warehouse/products/:id', descriptor: productFormView, permission: 'product:product:read' },
]
