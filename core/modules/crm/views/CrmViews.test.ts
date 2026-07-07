import { describe, expect, it } from 'vitest'
import crm from './CrmViews'

// The module's contribution is descriptors + route wiring; assert it stays correct.
describe('crm FrontModule', () => {
  it('is named "crm" and exposes the dashboard, list, and form routes', () => {
    expect(crm.name).toBe('crm')
    expect(crm.routes.map((r) => r.path)).toEqual(['/crm', '/crm/list', '/crm/:id'])
  })

  it('wires a dashboard, a tree list, and a form, all over the crm entity', () => {
    const [dashboard, list, form] = crm.routes
    expect(dashboard.descriptor.viewType).toBe('dashboard')
    expect(list.descriptor.viewType).toBe('tree')
    expect(form.descriptor.viewType).toBe('form')
    expect(crm.routes.every((r) => r.descriptor.entity === 'crm')).toBe(true)
  })

  it('makes list rows open the contact form', () => {
    const list = crm.routes.find((r) => r.path === '/crm/list')
    expect(list?.descriptor.formPath).toBe('/crm/:id')
  })

  it('gates the Create button on the write permission — list only, never the dashboard', () => {
    const list = crm.routes.find((r) => r.path === '/crm/list')
    expect(list?.descriptor.createPermission).toBe('crm:contacts:write')
    expect(list?.descriptor.formPath).toBe('/crm/:id')

    const dashboard = crm.routes.find((r) => r.path === '/crm')
    expect(dashboard?.descriptor.createPermission).toBeUndefined()
  })

  it('guards every route with crm:contacts:read', () => {
    expect(crm.routes.every((r) => r.permission === 'crm:contacts:read')).toBe(true)
  })

  it('exposes the expected contact fields', () => {
    expect(crm.routes[0].descriptor.fields.map((f) => f.name)).toEqual([
      'name',
      'email',
      'company',
      'status',
      'contact',
    ])
  })
})
