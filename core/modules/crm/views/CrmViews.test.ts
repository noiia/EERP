import { describe, expect, it } from 'vitest'
import { behaviorRegistry, fieldLabel, validateDescriptorWidgets } from '@eerp/core-front'
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

  it('exposes the scalar fields on every view and the relations on the form only', () => {
    expect(crm.routes[0].descriptor.fields.map((f) => f.name)).toEqual([
      'name',
      'email',
      'company',
      'status',
      'score',
    ])
    const form = crm.routes.find((r) => r.path === '/crm/:id')
    expect(form?.descriptor.fields.map((f) => f.name)).toEqual([
      'picture',
      'signature',
      'name',
      'email',
      'company',
      'status',
      'score',
      'phone',
      'satisfaction',
      'deals',
      'notes',
      'display_name',
      'contact_id',
      'tags',
    ])
    const byName = new Map(form?.descriptor.fields.map((f) => [f.name, f]))
    expect(byName.get('contact_id')?.relation).toEqual({
      entity: 'contact',
      kind: 'many2one',
      labelField: 'name',
    })
    expect(byName.get('tags')?.relation).toEqual({
      entity: 'tag',
      kind: 'many2many',
      via: 'crm_tag',
      labelField: 'name',
    })
  })

  it('declares only widget/type pairs the matrix allows, on every view', () => {
    for (const route of crm.routes) {
      expect(() => validateDescriptorWidgets(route.descriptor)).not.toThrow()
    }
  })

  // ── widget showcase (docs/roadmaps/field-widgets.md) ────────────────────────

  it('samples the Phase-1/3 widgets: signature, phone, percent, int, long', () => {
    const form = crm.routes.find((r) => r.path === '/crm/:id')
    const byName = new Map(form?.descriptor.fields.map((f) => [f.name, f]))
    expect(byName.get('picture')?.widget).toBe('picture')
    expect(byName.get('signature')?.widget).toBe('signature')
    expect(byName.get('signature')?.type).toBe('boolean')
    expect(byName.get('phone')?.widget).toBe('phone')
    // TEXT column on purpose — E.164's leading + would not survive a numeric one.
    expect(byName.get('phone')?.type).toBe('text')
    expect(byName.get('satisfaction')?.widget).toBe('percent')
    expect(byName.get('deals')?.widget).toBe('int')
    expect(byName.get('notes')?.widget).toBe('long')
    expect(byName.get('score')?.widgetOptions).toEqual({ max: 3 })
  })

  it('lets notes omit its label — the engine humanizes the field name', () => {
    const form = crm.routes.find((r) => r.path === '/crm/:id')
    const notes = form?.descriptor.fields.find((f) => f.name === 'notes')
    expect(notes?.label).toBeUndefined()
    expect(fieldLabel(notes!)).toBe('Notes')
  })

  it('samples both default styles: a literal on status, a function on satisfaction', () => {
    const form = crm.routes.find((r) => r.path === '/crm/:id')
    const byName = new Map(form?.descriptor.fields.map((f) => [f.name, f]))
    // Literal: new records seed as leads.
    expect(byName.get('status')?.default).toBe('lead')
    // Function (by NAME — descriptors stay data): registered and returning 50%.
    expect(byName.get('satisfaction')?.default).toBe('crm.defaultSatisfaction')
    const fn = behaviorRegistry.fieldFunction('crm.defaultSatisfaction')
    expect(fn?.entity).toBe('crm')
    expect(fn?.handler({})).toBe(0.5)
  })

  // ── behavior layer showcase ─────────────────────────────────────────────────

  it('registers crm.scoreFromStatus: status SUGGESTS the score, stars stay editable', () => {
    const handler = behaviorRegistry
      .onChangeFor('crm')
      .find((h) => h.name === 'crm.scoreFromStatus')
    expect(handler?.onChange).toEqual(['status'])
    expect(handler?.handler({ status: 'lead' })).toEqual({ score: 1 })
    expect(handler?.handler({ status: 'Customer' })).toEqual({ score: 3 })
    expect(handler?.handler({ status: 'churned' })).toEqual({ score: 0 })
    expect(handler?.handler({})).toEqual({ score: 0 })

    // Editable on purpose: an on_change suggestion, NOT a compute — a compute
    // would render the stars disabled. Stored (no store:false): it commits
    // into the indexed score column.
    const form = crm.routes.find((r) => r.path === '/crm/:id')
    const score = form?.descriptor.fields.find((f) => f.name === 'score')
    expect(score?.compute).toBeUndefined()
    expect(score?.store).toBeUndefined()
    expect(score?.widget).toBe('stars')
  })

  it('registers crm.displayName as a display-only (store:false) compute', () => {
    const fn = behaviorRegistry.fieldFunction('crm.displayName')
    expect(fn?.depends).toEqual(['name', 'company'])
    expect(fn?.handler({ name: 'Ada', company: 'Acme' })).toBe('Ada (Acme)')
    expect(fn?.handler({ name: 'Ada' })).toBe('Ada')

    const form = crm.routes.find((r) => r.path === '/crm/:id')
    const display = form?.descriptor.fields.find((f) => f.name === 'display_name')
    expect(display?.compute).toBe('crm.displayName')
    expect(display?.store).toBe(false)
  })

  it('registers crm.suggestEmail: company edits patch an empty email only', () => {
    const handler = behaviorRegistry.onChangeFor('crm').find((h) => h.name === 'crm.suggestEmail')
    expect(handler?.onChange).toEqual(['company'])
    expect(handler?.handler({ company: 'Acme Corp.' })).toEqual({ email: 'contact@acmecorp.com' })
    // Never clobbers what the user already typed.
    expect(handler?.handler({ company: 'Acme', email: 'ada@ada.io' })).toBeUndefined()
    expect(handler?.handler({ company: '' })).toBeUndefined()
  })
})
