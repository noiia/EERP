import type { ViewDescriptor } from '@eerp/core-front'

// Settings → Company: descriptors only, like core/modules/reportlayout's
// page-formats descriptors. The entity maps to core/modules/company's
// generic-CRUD table (GET/POST /api/v1/company, GET/PUT/DELETE .../:id) — a
// plain Go module, not one discovered via the module-registry FrontModule
// pipeline, since Company has no on-screen route of its own outside this
// hand-built top-level Settings tile (same posture as Users/Roles).

/** The record shape at this boundary — the engine only needs HasId. */
export type CompanyRecord = { id: string } & Record<string, unknown>

export const companyListDescriptor: ViewDescriptor<CompanyRecord> = {
  entity: 'company',
  viewType: 'tree',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'phone', label: 'Phone', type: 'text', widget: 'phone' },
    { name: 'email', label: 'Email', type: 'text' },
  ],
  formPath: '/settings/company/:id',
  createPermission: 'company:company:write',
  permissions: ['company:company:read'],
}

export const companyFormDescriptor: ViewDescriptor<CompanyRecord> = {
  entity: 'company',
  viewType: 'form',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'address', label: 'Address', type: 'text', widget: 'long' },
    { name: 'phone', label: 'Phone', type: 'text', widget: 'phone' },
    { name: 'email', label: 'Email', type: 'text' },
  ],
  permissions: ['company:company:read'],
}
