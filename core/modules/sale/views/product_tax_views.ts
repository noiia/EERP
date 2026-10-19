import type { Operation } from '@eerp/core-front'

// product_tax — a product's taxes (modules/sale/product_tax.go). Sale owns the
// tax catalog, so it adds the Taxes field to warehouse's product form itself
// (a view extension, sale_views.ts), next to the price: the same many2many
// tags widget over sale_tax that invoice lines and property billing lines use.
// An invoice line created from the product inherits these taxes; a quote line
// folds the percentage ones into its rate.
export const productTaxesOperations: Operation[] = [
  {
    op: 'addField',
    field: {
      name: 'taxes',
      label: 'Taxes',
      type: 'relation',
      relation: {
        entity: 'sale_tax',
        kind: 'many2many',
        via: 'product_tax',
        viaFields: { own: 'product_id', related: 'sale_tax_id' },
        labelField: 'name',
      },
    },
    target: 'unit_price',
    position: 'after',
  },
]
