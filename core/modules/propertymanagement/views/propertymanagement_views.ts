import type { FrontModule } from '@eerp/core-front'
import { dashboardRoute, propertyExtendOperations, propertyRoutes } from './property_management_views'
import { equipmentExtendOperations, equipmentRoutes } from './property_management_equipment_views'
import { equipmentStatusRoutes } from './property_management_equipment_status_views'
import { receiptExtendOperations, rentReceiptRoutes } from './property_management_rent_receipt_views'
import { rentReceiptReport } from '../reports/rent_receipt_report'

// Property management frontend — DESCRIPTORS ONLY (same discipline as
// core/modules/crm's crm_views.ts). This file is ONLY an assembler: one
// FrontModule per module.json, per ModuleRegistry.register()'s "idempotent
// by module name" contract (registry.ts) — a second register() call under
// the same name is silently skipped, not merged, so this module's six
// entities can't each independently register their own FrontModule the way
// separate modules do (see core/modules/propertymanagement/module.go's doc
// comments for the full data model). Each entity instead owns a dedicated
// <entity>_views.ts file exporting its own pieces (fields, descriptors,
// routes, behaviors registered at import time); this file only imports and
// assembles them. property_management_photo and
// property_management_equipment_photo have no dedicated route/descriptor of
// their own (they're only ever referenced as one2many relation targets from
// the property/equipment forms), so they get no separate file. The report
// lives in ../reports/rent_receipt_report.ts (a sibling of views/). Only
// this file is listed in module.json's static_files.views — the others are
// plain ES imports, not separately discovered.

const propertymanagement: FrontModule = {
  name: 'propertymanagement',
  routes: [
    // dashboardRoute MUST be first — Menu.tsx's landing tile links to
    // module.routes[0].path (see property_management_views.ts's own doc
    // comment).
    dashboardRoute,
    ...propertyRoutes,
    ...equipmentRoutes,
    ...equipmentStatusRoutes,
    ...rentReceiptRoutes,
  ],
  reports: [rentReceiptReport],
  extends: [
    { path: '/propertymanagement/:id', operations: propertyExtendOperations },
    { path: '/propertymanagement/equipment/:id', operations: equipmentExtendOperations },
    { path: '/propertymanagement/receipts/:id', operations: receiptExtendOperations },
  ],
}

export default propertymanagement
