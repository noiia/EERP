import { describe, expect, it } from 'vitest'
import {
  behaviorRegistry,
  fieldLabel,
  fieldZeroDefault,
  FORM_NOTEBOOK_ID,
  ModuleRegistry,
  normalizeLayout,
  validateDescriptorWidgets,
} from '@eerp/core-front'
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
    // 'signature' is NOT in this raw, un-extended base descriptor — it's
    // added by crm's OWN `extends` (see the registry-level describe block
    // below), the same way crminheritdemo adds fields to crm from outside.
    const form = crm.routes.find((r) => r.path === '/crm/:id')
    expect(form?.descriptor.fields.map((f) => f.name)).toEqual([
      'picture',
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

  it('samples the Phase-1/3 widgets: phone, percent, int, long', () => {
    const form = crm.routes.find((r) => r.path === '/crm/:id')
    const byName = new Map(form?.descriptor.fields.map((f) => [f.name, f]))
    expect(byName.get('picture')?.widget).toBe('picture')
    expect(byName.get('phone')?.widget).toBe('phone')
    // TEXT column on purpose — E.164's leading + would not survive a numeric one.
    expect(byName.get('phone')?.type).toBe('text')
    expect(byName.get('satisfaction')?.widget).toBe('percent')
    expect(byName.get('deals')?.widget).toBe('int')
    expect(byName.get('notes')?.widget).toBe('long')
    expect(byName.get('score')?.widgetOptions).toEqual({ max: 3 })
    expect(byName.get('status')?.type).toBe('selection')
    expect(byName.get('status')?.widget).toBeUndefined() // defaults to 'select'
    expect(byName.get('status')?.selection).toEqual({
      options: ['incoming', 'running', 'won', 'lost', 'closed'],
    })
  })

  it('lets notes omit its label — the engine humanizes the field name', () => {
    const form = crm.routes.find((r) => r.path === '/crm/:id')
    const notes = form?.descriptor.fields.find((f) => f.name === 'notes')
    expect(notes?.label).toBeUndefined()
    expect(fieldLabel(notes!)).toBe('Notes')
  })

  it('samples both default styles: a type-implicit default on status, a function on satisfaction', () => {
    const form = crm.routes.find((r) => r.path === '/crm/:id')
    const byName = new Map(form?.descriptor.fields.map((f) => [f.name, f]))
    // status declares NO explicit `default` — a selection field's own rule
    // (fieldZeroDefault) seeds the first option, 'incoming', for every new
    // record.
    expect(byName.get('status')?.default).toBeUndefined()
    expect(fieldZeroDefault(byName.get('status')!)).toBe('incoming')
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
    expect(handler?.handler({ status: 'incoming' })).toEqual({ score: 1 })
    expect(handler?.handler({ status: 'running' })).toEqual({ score: 2 })
    expect(handler?.handler({ status: 'won' })).toEqual({ score: 3 })
    expect(handler?.handler({ status: 'lost' })).toEqual({ score: 0 })
    expect(handler?.handler({ status: 'closed' })).toEqual({ score: 0 })
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

// crm extends its OWN already-registered '/crm/:id' route (a module may
// target a path it owns, not just another module's) to add a "Signature"
// notebook page coded directly here — docs/roadmaps/responsive-displays.md,
// Phase 4's "as easy to create as the current views" contract, demonstrated
// by the entity's OWN module rather than a cross-module example.
describe('crm — self-extended "Signature" notebook page (registry-level)', () => {
  function register(): ModuleRegistry {
    const registry = new ModuleRegistry()
    registry.register(crm)
    return registry
  }

  it('the RESOLVED /crm/:id form gains signature in its field REGISTRY (absent from the raw base)', () => {
    const registry = register()
    const resolved = registry.buildRegistry().get('/crm/:id')!
    const byName = new Map(resolved.descriptor.fields.map((f) => [f.name, f]))
    expect(byName.get('signature')?.widget).toBe('signature')
    expect(byName.get('signature')?.type).toBe('boolean')
  })

  it('signature lands on its OWN "Signature" tab, not __form_columns', () => {
    const registry = register()
    const resolved = registry.buildRegistry().get('/crm/:id')!
    const nodes = normalizeLayout(resolved.descriptor)
    const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    expect(notebook).toBeDefined()
    if (notebook && notebook.kind !== 'field') {
      const signaturePage = notebook.children.find((p) => p.kind !== 'field' && p.title === 'Signature')
      expect(signaturePage).toBeDefined()
      if (signaturePage && signaturePage.kind !== 'field') {
        expect(signaturePage.children).toEqual([{ kind: 'field', name: 'signature' }])
      }
    }
  })

  it('/crm/list and /crm are untouched — the extension targets only :id', () => {
    const registry = register()
    expect(registry.buildRegistry().get('/crm/list')?.descriptor.fields.map((f) => f.name)).not.toContain(
      'signature',
    )
    expect(registry.buildRegistry().get('/crm')?.descriptor.fields.map((f) => f.name)).not.toContain('signature')
  })
})

// docs/roadmaps/pdf-reports.md Phase 4 — the first real ReportDescriptor.
describe('crm.statement report', () => {
  it('is registered by name, over the crm entity, guarded by the read permission', () => {
    const registry = new ModuleRegistry().register(crm)
    const report = registry.buildReportRegistry().get('crm.statement')
    expect(report).toBeDefined()
    expect(report?.entity).toBe('crm')
    expect(report?.permissions).toEqual(['crm:contacts:read'])
  })

  it('every field node names a real crm field the form/list views also declare', () => {
    const report = crm.reports?.find((r) => r.name === 'crm.statement')
    const knownFields = new Set(crm.routes.flatMap((r) => r.descriptor.fields.map((f) => f.name)))
    const fieldNames: string[] = []
    const walk = (nodes: NonNullable<typeof report>['layout']): void => {
      for (const node of nodes) {
        if (node.kind === 'field') fieldNames.push(node.name)
        else if (node.kind === 'section') walk(node.children)
      }
    }
    walk(report?.layout ?? [])
    expect(fieldNames.length).toBeGreaterThan(0)
    for (const name of fieldNames) {
      expect(knownFields.has(name)).toBe(true)
    }
  })

  it('contains a pageBreak, splitting the header/metrics from the notes section', () => {
    const report = crm.reports?.find((r) => r.name === 'crm.statement')
    expect(report?.layout.some((n) => n.kind === 'pageBreak')).toBe(true)
  })
})
