import { describe, expect, it } from 'vitest'
import mod from './WarehouseViews'

describe('warehouse FrontModule', () => {
  it('registers the expected routes: one dashboard, two list/form pairs', () => {
    expect(mod.name).toBe('warehouse')
    expect(mod.routes.map((r) => r.path)).toEqual([
      '/warehouse',
      '/warehouse/products/list',
      '/warehouse/products/:id',
      '/warehouse/variants/list',
      '/warehouse/variants/:id',
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

  it('exactly two tree (list) views exist, over distinct entities — one dashboard tile each', () => {
    // The dashboard itself names no tiles: apps/shell/app/[...module]/resolve.ts's
    // dashboardListViews rolls up every 'tree' viewType route this module owns
    // (ModuleRegistry.listViews) into one card each — so this precondition is
    // what actually produces the Product / Product Variant tiles.
    const treeRoutes = mod.routes.filter((r) => r.descriptor.viewType === 'tree')
    expect(treeRoutes.map((r) => r.path)).toEqual(['/warehouse/products/list', '/warehouse/variants/list'])
    expect(treeRoutes.map((r) => r.descriptor.entity)).toEqual(['product', 'product_variant'])
  })
})
