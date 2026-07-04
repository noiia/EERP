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
  { name: 'contact', label: 'Contact', type: 'relation'}
]

const dashboardView: ViewDescriptor = {
  entity: 'crm',
  viewType: 'dashboard', 
  fields,
  permissions: ['crm:contacts:read'],
}

const listView: ViewDescriptor = {
  entity: 'crm',
  viewType: 'tree',
  fields,
  // Clicking a row opens that contact's form.
  formPath: '/crm/:id',
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
