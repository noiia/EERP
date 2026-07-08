import { describe, expect, it } from 'vitest'
import contacts from './ContactsViews'

// The module's contribution is descriptors + route wiring; assert it stays correct.
describe('contacts FrontModule', () => {
  it('is named "contacts" and exposes the dashboard, list, and form routes', () => {
    expect(contacts.name).toBe('contacts')
    expect(contacts.routes.map((r) => r.path)).toEqual([
      '/contacts',
      '/contacts/list',
      '/contacts/:id',
    ])
  })

  it('wires a dashboard, a tree list, and a form, all over the backend "contact" entity', () => {
    const [dashboard, list, form] = contacts.routes
    expect(dashboard.descriptor.viewType).toBe('dashboard')
    expect(list.descriptor.viewType).toBe('tree')
    expect(form.descriptor.viewType).toBe('form')
    // entity = the Go route prefix (snake_case struct name), NOT the module/route slug.
    expect(contacts.routes.every((r) => r.descriptor.entity === 'contact')).toBe(true)
  })

  it('makes list rows open the contact form', () => {
    const list = contacts.routes.find((r) => r.path === '/contacts/list')
    expect(list?.descriptor.formPath).toBe('/contacts/:id')
  })

  it('gates the Create button on the write permission — list only, never the dashboard', () => {
    const list = contacts.routes.find((r) => r.path === '/contacts/list')
    expect(list?.descriptor.createPermission).toBe('contact:contact:write')

    const dashboard = contacts.routes.find((r) => r.path === '/contacts')
    expect(dashboard?.descriptor.createPermission).toBeUndefined()
  })

  it('requires the backend-derived read permission on every view descriptor', () => {
    expect(
      contacts.routes.every((r) => r.descriptor.permissions?.includes('contact:contact:read')),
    ).toBe(true)
  })

  it('exposes the contact fields under their snake_case column names', () => {
    expect(contacts.routes[0].descriptor.fields.map((f) => f.name)).toEqual([
      'name',
      'email',
      'company',
      'status',
    ])
  })

  it('embeds the inverse CRM records on the form only (one2many)', () => {
    const form = contacts.routes.find((r) => r.path === '/contacts/:id')
    const o2m = form?.descriptor.fields.find((f) => f.name === 'crm_records')
    expect(o2m?.relation).toEqual({
      entity: 'crm',
      kind: 'one2many',
      inverseField: 'contact_id',
      labelField: 'name',
    })
    const list = contacts.routes.find((r) => r.path === '/contacts/list')
    expect(list?.descriptor.fields.some((f) => f.name === 'crm_records')).toBe(false)
  })
})
