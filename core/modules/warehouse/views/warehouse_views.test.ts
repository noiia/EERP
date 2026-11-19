import { describe, expect, it } from 'vitest'
import { evaluateCondition, FORM_HEADER_ID } from '@eerp/core-front'
import mod from './warehouse_views'

describe('warehouse FrontModule', () => {
  it('registers the expected routes: one dashboard, three list/form pairs', () => {
    expect(mod.name).toBe('warehouse')
    expect(mod.routes.map((r) => r.path)).toEqual([
      '/warehouse',
      '/warehouse/products/list',
      '/warehouse/products/:id',
      '/warehouse/variants/list',
      '/warehouse/variants/:id',
      '/warehouse/uoms/list',
      '/warehouse/uoms/:id',
    ])
  })

  it('the app landing page is a single dashboard route', () => {
    const dashboard = mod.routes.find((r) => r.path === '/warehouse')!
    expect(dashboard.descriptor.viewType).toBe('dashboard')
  })

  it('product routes target the product entity', () => {
    const productRoutes = mod.routes.filter((r) => r.path.startsWith('/warehouse/products'))
    for (const route of productRoutes) {
      expect(route.descriptor.entity).toBe('product')
    }
  })

  it('variant routes target the product_variant entity, product_id required', () => {
    const variantRoutes = mod.routes.filter((r) => r.path.startsWith('/warehouse/variants'))
    for (const route of variantRoutes) {
      expect(route.descriptor.entity).toBe('product_variant')
    }
    const formRoute = mod.routes.find((r) => r.path === '/warehouse/variants/:id')!
    const productField = formRoute.descriptor.fields.find((f) => f.name === 'product_id')
    expect(productField?.required).toBe(true)
  })

  it('exactly three tree (list) views exist, over distinct entities — one dashboard tile each', () => {
    // The dashboard itself names no tiles: apps/shell/app/[...module]/resolve.ts's
    // dashboardListViews rolls up every 'tree' viewType route this module owns
    // (ModuleRegistry.listViews) into one card each — so this precondition is
    // what actually produces the Product / Product Variant / Unit tiles.
    const treeRoutes = mod.routes.filter((r) => r.descriptor.viewType === 'tree')
    expect(treeRoutes.map((r) => r.path)).toEqual([
      '/warehouse/products/list',
      '/warehouse/variants/list',
      '/warehouse/uoms/list',
    ])
    expect(treeRoutes.map((r) => r.descriptor.entity)).toEqual(['product', 'product_variant', 'product_uoms'])
  })

  it('uom routes target the product_uoms entity, name and type required', () => {
    const uomRoutes = mod.routes.filter((r) => r.path.startsWith('/warehouse/uoms'))
    for (const route of uomRoutes) {
      expect(route.descriptor.entity).toBe('product_uoms')
    }
    const formRoute = mod.routes.find((r) => r.path === '/warehouse/uoms/:id')!
    expect(formRoute.descriptor.fields.find((f) => f.name === 'name')?.required).toBe(true)
    const symbolField = formRoute.descriptor.fields.find((f) => f.name === 'symbol')
    expect(symbolField).toMatchObject({ type: 'text', required: true })
    const typeField = formRoute.descriptor.fields.find((f) => f.name === 'type')
    expect(typeField?.required).toBe(true)
    expect(typeField?.selection?.options).toEqual(['piece', 'length', 'weight', 'volume', 'surface', 'custom'])
  })
})

describe('warehouse — product form', () => {
  const form = () => mod.routes.find((r) => r.path === '/warehouse/products/:id')!.descriptor

  it('has no unit and no single tax rate (taxes are sale\'s Taxes field)', () => {
    const names = form().fields.map((f) => f.name)
    expect(names).not.toContain('unit')
    expect(names).not.toContain('tax_rate')
  })

  it('shows the picture on top, beside the name', () => {
    const header = form().layout?.find((n) => n.kind !== 'field' && n.id === FORM_HEADER_ID)
    expect(header && header.kind !== 'field' ? header.children : []).toEqual([
      { kind: 'field', name: 'picture' },
      { kind: 'field', name: 'name', variant: 'title' },
    ])
  })

  it('makes the reference read-only while the warehouse setting auto_reference is on', () => {
    expect(form().formContext).toBe('/settings/warehouse')
    const reference = form().fields.find((f) => f.name === 'reference')!
    expect(reference.required).toBeUndefined()
    expect(reference.states?.readOnly).toEqual({ field: 'context.auto_reference', op: 'eq', value: true })
    expect(evaluateCondition(reference.states!.readOnly!, { 'context.auto_reference': true })).toBe(true)
    expect(evaluateCondition(reference.states!.readOnly!, { 'context.auto_reference': false })).toBe(false)
  })
})
