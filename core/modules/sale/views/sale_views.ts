import type { FrontModule } from '@eerp/core-front'
import { dashboardRoute, invoiceRoutes, orderLinesPageOperations } from './invoice_views'
import { quoteRoutes, quoteLinesPageOperations } from './quote_views'
import { saleLineRoutes } from './sale_line_views'
import { quoteLineRoutes } from './quote_line_views'
import { invoiceReport } from '../reports/invoice_report'
import { quoteReport } from '../reports/quote_report'

// Sale frontend — DESCRIPTORS ONLY (same discipline as core/modules/crm's
// crm_views.ts). This file is ONLY an assembler: one FrontModule per
// module.json, per ModuleRegistry.register()'s "idempotent by module name"
// contract (registry.ts) — a second register() call under the same name is
// silently skipped, not merged, so the four entities below (invoice/
// sale_line/quote/quote_line) can't each independently register their own
// FrontModule the way separate modules do. Each entity instead owns a
// dedicated <entity>_views.ts file exporting its own pieces (fields,
// descriptors, routes, behaviors registered at import time); this file only
// imports and assembles them. Reports live in their own ../reports/<name>_
// report.ts files (a sibling of views/, one per ReportDescriptor). Only this
// file is listed in module.json's static_files.views — the others are plain
// ES imports, not separately discovered.

const sale: FrontModule = {
  name: 'sale',
  routes: [
    // dashboardRoute MUST be first — Menu.tsx's landing tile links to
    // module.routes[0].path (see invoice_views.ts's own doc comment).
    dashboardRoute,
    // quote's routes registered before invoice's — see quote_views.ts's own
    // doc comment on quoteRoutes for why (the dashboard tile order).
    ...quoteRoutes,
    ...quoteLineRoutes,
    ...invoiceRoutes,
    ...saleLineRoutes,
  ],
  reports: [invoiceReport, quoteReport],
  extends: [
    { path: '/sale/:id', operations: orderLinesPageOperations },
    { path: '/sale/quote/:id', operations: quoteLinesPageOperations },
  ],
}

export default sale
