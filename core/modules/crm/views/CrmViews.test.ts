import { describe, expect, it } from 'vitest'
import crm from './CrmViews'

// The module's contribution is descriptors + route wiring; assert it stays correct.
describe('crm FrontModule', () => {
  it('is named "crm" and exposes the contact list + form routes', () => {
    expect(crm.name).toBe('crm')
    expect(crm.routes.map((r) => r.path)).toEqual(['/crm/contacts', '/crm/contacts/:id'])
  })

  it('wires a tree list and a form, both over the crm entity', () => {
    const [list, form] = crm.routes
    expect(list.descriptor.viewType).toBe('tree')
    expect(form.descriptor.viewType).toBe('form')
    expect(list.descriptor.entity).toBe('crm')
    expect(form.descriptor.entity).toBe('crm')
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
    ])
  })
})
