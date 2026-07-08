import type { FrontModule, ViewDescriptor } from '@eerp/core-front'

// contacts frontend — DESCRIPTORS ONLY. The engine derives the server loader, the Zustand
// store, and the renderer from these; this module ships no controllers or renderers.
// A custom component here would signal an engine gap to fix in @eerp/core-front.
//
// `entity` maps 1:1 to the Go route prefix: the backend registers the Contact struct
// on the generic CRUD surface as snake_case "contact" (GET /api/v1/contact). Field
// names must match the DB column names the handler returns (snake_case), and the
// permission strings mirror what Go derives from that route: contact:contact:<action>.

export interface Contact {
  id: string
  tenant_id: string
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

// Form-only: the inverse side of crm.contact_id — every CRM record pointing at
// this contact, embedded read-only (relation/list). Virtual: never in the
// contact's commit payload.
const formFields: ViewDescriptor['fields'] = [
  ...fields,
  {
    name: 'crm_records',
    label: 'CRM records',
    type: 'relation',
    relation: { entity: 'crm', kind: 'one2many', inverseField: 'contact_id', labelField: 'name' },
  },
]

const dashboardView: ViewDescriptor = {
  entity: 'contact',
  viewType: 'dashboard',
  fields,
  permissions: ['contact:contact:read'],
}

const listView: ViewDescriptor = {
  entity: 'contact',
  viewType: 'tree',
  fields,
  formPath: '/contacts/:id',
  createPermission: 'contact:contact:write',
  permissions: ['contact:contact:read'],
}

const formView: ViewDescriptor = {
  entity: 'contact',
  viewType: 'form',
  fields: formFields,
  permissions: ['contact:contact:read'],
}

const contacts: FrontModule = {
  name: 'contacts',
  routes: [
    { path: '/contacts', descriptor: dashboardView },
    { path: '/contacts/list', descriptor: listView },
    { path: '/contacts/:id', descriptor: formView },
  ],
}

export default contacts
