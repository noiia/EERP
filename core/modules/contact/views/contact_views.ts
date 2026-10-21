import {
  FORM_COLUMNS_ID,
  FORM_NOTEBOOK_ID,
  PAGE_SETTINGS_ID,
  type FrontModule,
  type GeoJSONGeometry,
  type Operation,
  type ViewDescriptor,
} from '@eerp/core-front'

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
  /** A company (parent) or a person (child), linked many2many through
   * contact_company. Older rows read as 'contact'. */
  kind?: 'company' | 'contact' | null
  /** Created by a website signup (set by Go, never edited). */
  website?: boolean | null
  /** Where the contact is — a GeoJSON Point (map pick or geocoded). */
  geo_location?: GeoJSONGeometry | null
}

const fields: ViewDescriptor['fields'] = [
  {
    name: 'kind',
    label: 'Type',
    type: 'selection',
    widget: 'radio',
    selection: { options: ['company', 'contact'] },
    default: 'contact',
  },
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'text', required: true },
  { name: 'company', label: 'Company', type: 'text' },
  { name: 'status', label: 'Status', type: 'text' },
  { name: 'website', label: 'Website', type: 'boolean', widget: 'switch', readOnly: true },
  // A map point. Kept in the tree's fields too: the grid never renders a geo
  // column, but the search bar offers it as near / inside-zone filters.
  {
    name: 'geo_location',
    label: 'Location',
    type: 'geo',
    widget: 'point',
    widgetOptions: { zones: [{ entity: 'company', field: 'service_zone', label: 'Company service zone' }] },
  },
]

// The parent/child links, both sides of the same contact_company junction:
// a company lists its contacts, a contact the companies it belongs to (0..n
// either way). Each side only offers rows of the other kind, and shows only
// on its own kind — the notebook drops the page whose field is hidden.
const companiesField: ViewDescriptor['fields'][number] = {
  name: 'companies',
  label: 'Companies',
  type: 'relation',
  relation: {
    entity: 'contact',
    kind: 'many2many',
    via: 'contact_company',
    viaFields: { own: 'contact_id', related: 'company_id' },
    labelField: 'name',
    filter: { kind: 'company' },
  },
  states: { visible: { field: 'kind', op: 'ne', value: 'company' } },
}
const contactsField: ViewDescriptor['fields'][number] = {
  name: 'contacts',
  label: 'Contacts',
  type: 'relation',
  relation: {
    entity: 'contact',
    kind: 'many2many',
    via: 'contact_company',
    viaFields: { own: 'company_id', related: 'contact_id' },
    labelField: 'name',
    filter: { kind: 'contact' },
  },
  states: { visible: { field: 'kind', op: 'eq', value: 'company' } },
}

// The children come first in the notebook: Contacts on a company, Companies
// on a contact.
export const relationsPageOperations: Operation[] = [
  { op: 'addField', field: companiesField },
  { op: 'addField', field: contactsField },
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Companies', children: [{ kind: 'field', name: 'companies' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Contacts', children: [{ kind: 'field', name: 'contacts' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
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
    relation: {
      entity: 'crm',
      kind: 'one2many',
      inverseField: 'contact_id',
      labelField: 'name',
    },
  },
]

// The CRM records table and the map share one row (table left, map right)
// below the main field columns, instead of the tall map leaving the table on a
// row of its own. Narrow forms stack them.
export const locationRowOperations: Operation[] = [
  {
    op: 'addNode',
    node: {
      kind: 'group',
      id: 'contact_location',
      columns: 2,
      children: [
        { kind: 'field', name: 'crm_records' },
        { kind: 'field', name: 'geo_location' },
      ],
    },
    target: FORM_COLUMNS_ID,
    position: 'after',
  },
  // A read-only flag set by a website signup: kept out of the main columns,
  // where it took a row of its own, on the Settings page.
  { op: 'move', name: 'website', target: PAGE_SETTINGS_ID, position: 'last' },
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
  name: 'contact',
  routes: [
    { path: '/contacts', descriptor: dashboardView },
    { path: '/contacts/list', descriptor: listView },
    { path: '/contacts/:id', descriptor: formView },
  ],
  extends: [
    { path: '/contacts/:id', operations: [...relationsPageOperations, ...locationRowOperations] },
  ],
}

export default contacts
