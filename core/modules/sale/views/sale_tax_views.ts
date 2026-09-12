import { registerHeaderMenu, type FrontRoute, type ViewDescriptor } from '@eerp/core-front'

// sale_tax — a reusable tax definition (core/modules/sale/module.go's
// SaleTax): a percentage (0..1 ratio, applied to a line's own base price) or
// a flat fixed amount, picked by `kind`. Tagged onto sale_line
// (sale_line_views.ts's `taxes` field) AND propertymanagement's billing_line
// (property_management_billing_line_views.ts) via their own many2many —
// this is the one entity BOTH modules point at, which is why it lives here
// rather than under either line's own file.

/** One sale_tax row. */
export interface SaleTax {
  id: string
  name: string
  /** Selects which of rate/amount below the backend actually applies. */
  kind: 'percentage' | 'fixed'
  /** 0..1 ratio (percent widget ×100); read only when kind is 'percentage'. */
  rate?: number
  /** A flat amount added once per line; read only when kind is 'fixed'. */
  amount?: number
}

// Both modes stay on the form at once (the user's own request) — `states.
// visible` just switches which ONE is relevant to fill in for the chosen
// kind, so a value entered under the "wrong" kind isn't silently lost on
// toggle, only hidden. No `default` on kind: type: 'selection' seeds the
// FIRST option ('percentage') for every new tax on its own (same rule
// crm_views.ts's status field relies on).
const saleTaxFields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'kind', label: 'Type', type: 'selection', selection: { options: ['percentage', 'fixed'] } },
  {
    name: 'rate',
    label: 'Rate',
    type: 'number',
    widget: 'percent',
    states: { visible: { field: 'kind', op: 'eq', value: 'percentage' } },
  },
  {
    name: 'amount',
    label: 'Amount',
    type: 'number',
    widget: 'monetary',
    states: { visible: { field: 'kind', op: 'eq', value: 'fixed' } },
  },
]

const saleTaxFormView: ViewDescriptor = {
  entity: 'sale_tax',
  viewType: 'form',
  fields: saleTaxFields,
  permissions: ['sale_tax:sale_tax:read'],
}

const saleTaxListView: ViewDescriptor = {
  entity: 'sale_tax',
  viewType: 'tree',
  fields: saleTaxFields,
  formPath: '/sale/taxes/:id',
  createPermission: 'sale_tax:sale_tax:write',
  permissions: ['sale_tax:sale_tax:read'],
  // Lives inside sale's Configuration header menu (below) instead of getting
  // its own top-bar button — a tax catalog is workspace configuration, not a
  // day-to-day list like Orders/Products.
  hideFromTopBar: true,
}

export const saleTaxRoutes: FrontRoute[] = [
  { path: '/sale/taxes', descriptor: saleTaxListView, permission: 'sale_tax:sale_tax:read' },
  { path: '/sale/taxes/:id', descriptor: saleTaxFormView, permission: 'sale_tax:sale_tax:read' },
]

// Adds a "Taxes" line to sale's own Configuration header menu (see
// ModuleRegistry.headerMenus(), which always seeds that menu with a default
// "Settings" line first) — the first real user of registerHeaderMenu.
registerHeaderMenu('sale', 'configuration', {
  entries: [{ kind: 'line', label: 'Taxes', path: '/sale/taxes', permission: 'sale_tax:sale_tax:read' }],
})
