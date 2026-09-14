import { type FrontRoute, type ViewDescriptor } from '@eerp/core-front'

// quote_line — mirrors sale_line (sale_line_views.ts), scoped to a Quote.

/** One quote_line row — mirrors SaleLine, scoped to a Quote. */
export interface QuoteLine {
  id: string
  quote_id: string
  variant_id: string
  variant_name?: string
  quantity: number
  unit?: string
  tax_rate?: number
  unit_price?: number
}

// quote_line's own descriptor — needed for the quote form's one2many
// create-wizard, same reasoning as sale_line_views.ts's own descriptor.
const quoteLineFields: ViewDescriptor['fields'] = [
  {
    name: 'quote_id',
    label: 'Quote',
    type: 'relation',
    required: true,
    relation: { entity: 'quote', kind: 'many2one', labelField: 'number' },
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

const quoteLineFormView: ViewDescriptor = {
  entity: 'quote_line',
  viewType: 'form',
  fields: quoteLineFields,
  permissions: ['quote_line:quote_line:read'],
}

export const quoteLineRoutes: FrontRoute[] = [
  { path: '/sale/quote/lines/:id', descriptor: quoteLineFormView, permission: 'quote_line:quote_line:read' },
]
