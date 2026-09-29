import type { FrontModule, ViewDescriptor } from '@eerp/core-front'

// event frontend — DESCRIPTORS ONLY. The engine derives the server loader, the
// Zustand store, and the renderer from these; this module ships no controllers
// or renderers.
//
// `entity` maps 1:1 to the Go route prefix registered by module.go's orm.Register —
// snake_case "event" (GET /api/v1/event). Field names must match the DB column
// names the handler returns, and permission strings mirror the route:
// event:event:<action>.

export interface Event {
  id: string
  tenant_id: string
  name: string
}

const fields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
]

const dashboardView: ViewDescriptor = {
  entity: 'event',
  viewType: 'dashboard',
  fields,
  permissions: ['event:event:read'],
}

const listView: ViewDescriptor = {
  entity: 'event',
  viewType: 'tree',
  fields,
  formPath: '/event/:id',
  createPermission: 'event:event:write',
  permissions: ['event:event:read'],
}

const formView: ViewDescriptor = {
  entity: 'event',
  viewType: 'form',
  fields,
  permissions: ['event:event:read'],
}

const event: FrontModule = {
  name: 'event',
  routes: [
    { path: '/event', descriptor: dashboardView },
    { path: '/event/list', descriptor: listView },
    { path: '/event/:id', descriptor: formView },
  ],
}

export default event
