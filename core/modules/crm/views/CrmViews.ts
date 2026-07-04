import type { FrontModule, ViewDescriptor } from '@eerp/core-front'

// CRM frontend — DESCRIPTORS ONLY. The engine derives the server loader, the Zustand
// store, and the renderer from these; this module ships no controllers or renderers.
// A custom component here would signal an engine gap to fix in @eerp/core-front.

/** The CRM record as served by Go's /crm endpoints (BaseModel + business fields). */
export interface Crm {
  id: string
  name: string
  email: string
  company?: string
  status?: string
}

const fields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'text', required: true },
  { name: 'company', label: 'Company', type: 'text' },
  { name: 'status', label: 'Status', type: 'text' },
]

const dashboardView: ViewDescriptor = {
  entity: 'crm',
  viewType: 'dashboard', // flat data (no parent_id) -> the engine renders a DataGrid
  fields,
  permissions: ['crm:contacts:read'],
}
// entity 'crm' maps to Go's /api/v1/crm routes (RoutePrefix = table name "crm").
const listView: ViewDescriptor = {
  entity: 'crm',
  viewType: 'tree', // flat data (no parent_id) -> the engine renders a DataGrid
  fields,
  permissions: ['crm:contacts:read'],
}

const formView: ViewDescriptor = {
  entity: 'crm',
  viewType: 'form',
  fields,
  permissions: ['crm:contacts:read'],
}

const crm: FrontModule = {
  name: 'crm',
  routes: [
    { path: '/crm', descriptor: dashboardView, permission: 'crm:contacts:read' },
    { path: '/crm/list', descriptor: listView, permission: 'crm:contacts:read' },
    { path: '/crm/:id', descriptor: formView, permission: 'crm:contacts:read' },
  ],
}

export default crm
