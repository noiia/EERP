import type { FrontModule, ViewDescriptor } from '@eerp/core-front'

// website frontend — DESCRIPTORS ONLY. The engine derives the server loader, the
// Zustand store, and the renderer from these; this module ships no controllers
// or renderers.
//
// `entity` maps 1:1 to the Go route prefix registered by module.go's orm.Register —
// snake_case "website" (GET /api/v1/website). Field names must match the DB column
// names the handler returns, and permission strings mirror the route:
// website:website:<action>.

export interface Website {
  id: string
  tenant_id: string
  name: string
}

const fields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
]

const dashboardView: ViewDescriptor = {
  entity: 'website',
  viewType: 'dashboard',
  fields,
  permissions: ['website:website:read'],
}

const listView: ViewDescriptor = {
  entity: 'website',
  viewType: 'tree',
  fields,
  formPath: '/website/:id',
  createPermission: 'website:website:write',
  permissions: ['website:website:read'],
}

const formView: ViewDescriptor = {
  entity: 'website',
  viewType: 'form',
  fields,
  permissions: ['website:website:read'],
}

const website: FrontModule = {
  name: 'website',
  routes: [
    { path: '/website', descriptor: dashboardView },
    { path: '/website/list', descriptor: listView },
    { path: '/website/:id', descriptor: formView },
  ],
}

export default website
