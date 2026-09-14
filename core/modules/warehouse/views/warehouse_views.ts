import type { FrontModule } from '@eerp/core-front'
import { dashboardRoute, productRoutes } from './product_views'
import { productVariantRoutes } from './product_variant_views'

// warehouse frontend — DESCRIPTORS ONLY (same discipline as core/modules/crm's
// crm_views.ts). Two entities, one module: `product` (the catalog entry) and
// `product_variant` (see core/modules/warehouse/module.go's doc comments).
// This file is ONLY an assembler — see core/modules/sale/views/sale_views.ts
// for the full rationale (ModuleRegistry.register() is idempotent by module
// name, so only ONE file may export the FrontModule). Each entity owns a
// dedicated <entity>_views.ts file; this file just imports and assembles
// them. Only this file is listed in module.json's static_files.views.

const warehouse: FrontModule = {
  name: 'warehouse',
  routes: [
    // dashboardRoute MUST be first — Menu.tsx's landing tile links to
    // module.routes[0].path (see product_views.ts's own doc comment).
    dashboardRoute,
    ...productRoutes,
    ...productVariantRoutes,
  ],
}

export default warehouse
