import { ModuleRegistry, normalizeLayout, resolveWidget, FORM_COLUMNS_ID, FORM_NOTEBOOK_ID, PAGE_SETTINGS_ID } from '@eerp/core-front'
import { describe, expect, it } from 'vitest'
import contacts from './contact_views'

// The module's contribution is descriptors + route wiring; assert it stays correct.
describe('contacts FrontModule', () => {
  it('is named "contact" (matches module.json, not the plural route paths) and exposes the dashboard, list, and form routes', () => {
    // FrontModule.name must match module.json's "name" ("contact", singular) — it's the
    // identity moduleViewRows/moduleNav/the App Store's Views tab key lookups on, distinct
    // from the route PATHS below (which stay plural, unrelated to this identity string).
    expect(contacts.name).toBe('contact')
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
      'kind',
      'name',
      'email',
      'company',
      'status',
      'website',
      'geo_location',
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

  it('carries a map point with the company service zone as a zone filter', () => {
    const form = contacts.routes.find((r) => r.path === '/contacts/:id')!.descriptor
    const geo = form.fields.find((f) => f.name === 'geo_location')!
    expect(geo).toMatchObject({ type: 'geo', widget: 'point' })
    expect(geo.widgetOptions?.zones).toEqual([{ entity: 'company', field: 'service_zone', label: 'Company service zone' }])
    expect(resolveWidget(geo)).toBe('point')
    // The tree keeps it for the near/inside search filters (the grid skips geo columns).
    const list = contacts.routes.find((r) => r.path === '/contacts/list')!.descriptor
    expect(list.fields.some((f) => f.name === 'geo_location')).toBe(true)
  })

  it('picks the kind with radio buttons, a new record being a contact', () => {
    const kind = contacts.routes[2].descriptor.fields.find((f) => f.name === 'kind')!
    expect(kind).toMatchObject({ type: 'selection', widget: 'radio', default: 'contact' })
    expect(kind.selection?.options).toEqual(['company', 'contact'])
  })

  it('links contacts and companies both ways, as the first notebook page of the matching kind', () => {
    const registry = new ModuleRegistry()
    registry.register(contacts)
    const form = registry.buildRegistry().get('/contacts/:id')!.descriptor
    const companies = form.fields.find((f) => f.name === 'companies')!
    const members = form.fields.find((f) => f.name === 'contacts')!
    expect(companies.relation).toMatchObject({
      entity: 'contact',
      kind: 'many2many',
      via: 'contact_company',
      viaFields: { own: 'contact_id', related: 'company_id' },
      filter: { kind: 'company' },
    })
    expect(members.relation).toMatchObject({
      via: 'contact_company',
      viaFields: { own: 'company_id', related: 'contact_id' },
      filter: { kind: 'contact' },
    })
    expect(companies.states?.visible).toEqual({ field: 'kind', op: 'ne', value: 'company' })
    expect(members.states?.visible).toEqual({ field: 'kind', op: 'eq', value: 'company' })

    const notebook = normalizeLayout(form).find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    if (!notebook || notebook.kind === 'field') throw new Error('no notebook')
    expect(notebook.children.slice(0, 2).map((p) => (p.kind === 'field' ? p.name : p.title))).toEqual([
      'Contacts',
      'Companies',
    ])
  })

  it('puts the CRM records table left of the map, on one row below the main columns', () => {
    const registry = new ModuleRegistry()
    registry.register(contacts)
    const layout = normalizeLayout(registry.buildRegistry().get('/contacts/:id')!.descriptor)
    const ids = layout.map((n) => (n.kind === 'field' ? n.name : n.id))
    expect(ids.indexOf('contact_location')).toBe(ids.indexOf(FORM_COLUMNS_ID) + 1)
    const row = layout.find((n) => n.kind !== 'field' && n.id === 'contact_location')
    if (!row || row.kind === 'field') throw new Error('no location row')
    expect(row.columns).toBe(2)
    expect(row.children.map((c) => (c.kind === 'field' ? c.name : c.id))).toEqual([
      'crm_records',
      'geo_location',
    ])
    // Both left the main columns.
    const columns = layout.find((n) => n.kind !== 'field' && n.id === FORM_COLUMNS_ID)
    if (!columns || columns.kind === 'field') throw new Error('no columns')
    const inColumns = columns.children.map((c) => (c.kind === 'field' ? c.name : c.id))
    expect(inColumns).not.toContain('crm_records')
    expect(inColumns).not.toContain('geo_location')
  })

  it('shows the Website flag on the Settings page, leaving the main columns two full rows', () => {
    const registry = new ModuleRegistry()
    registry.register(contacts)
    const layout = normalizeLayout(registry.buildRegistry().get('/contacts/:id')!.descriptor)
    const columns = layout.find((n) => n.kind !== 'field' && n.id === FORM_COLUMNS_ID)
    if (!columns || columns.kind === 'field') throw new Error('no columns')
    expect(columns.children.map((c) => (c.kind === 'field' ? c.name : c.id))).toEqual([
      'kind',
      'email',
      'company',
      'status',
    ])
    const notebook = layout.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    if (!notebook || notebook.kind === 'field') throw new Error('no notebook')
    const settings = notebook.children.find((p) => p.kind !== 'field' && p.id === PAGE_SETTINGS_ID)
    if (!settings || settings.kind === 'field') throw new Error('no settings page')
    expect(settings.children.map((c) => (c.kind === 'field' ? c.name : c.id))).toContain('website')
  })
})
