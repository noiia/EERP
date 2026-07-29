import { describe, expect, it } from 'vitest'
import { FORM_NOTEBOOK_ID, ModuleRegistry, normalizeLayout } from '@eerp/core-front'
import appstore from './AppStoreViews'

// The module's contribution is descriptors + route wiring; assert it stays correct.
describe('appstore FrontModule', () => {
  it('is named "appstore" and exposes the catalog and form routes', () => {
    expect(appstore.name).toBe('appstore')
    expect(appstore.routes.map((r) => r.path)).toEqual(['/appstore', '/appstore/:id'])
  })

  it('wires a catalog and a form, both over the virtual "modules" entity', () => {
    const [catalog, form] = appstore.routes
    expect(catalog.descriptor.viewType).toBe('catalog')
    expect(form.descriptor.viewType).toBe('form')
    expect(appstore.routes.every((r) => r.descriptor.entity === 'modules')).toBe(true)
  })

  it('guards every route with modules:modules:read', () => {
    expect(
      appstore.routes.every((r) => r.descriptor.permissions?.includes('modules:modules:read')),
    ).toBe(true)
    expect(appstore.routes.every((r) => r.permission === 'modules:modules:read')).toBe(true)
  })

  it('the catalog maps icon/title/subtitle to the raw module.json keys and links to the form', () => {
    const catalog = appstore.routes.find((r) => r.path === '/appstore')
    expect(catalog?.descriptor.catalog).toEqual({
      icon: 'icon',
      title: 'display_name',
      subtitle: 'description',
    })
    expect(catalog?.descriptor.formPath).toBe('/appstore/:id')
  })

  it('every declared FORM field is readOnly: true — there is no editable field on this form', () => {
    const form = appstore.routes.find((r) => r.path === '/appstore/:id')
    const fields = form?.descriptor.fields ?? []
    expect(fields.length).toBeGreaterThan(0)
    for (const field of fields) {
      expect(field.readOnly).toBe(true)
    }
  })

  it('the form fields are exactly the raw module.json keys this phase declares', () => {
    const form = appstore.routes.find((r) => r.path === '/appstore/:id')
    expect(form?.descriptor.fields.map((f) => f.name)).toEqual([
      'display_name',
      'name',
      'description',
      'version',
      'author',
      'type',
      'icon',
      'active',
      'app_mode',
    ])
  })

  it("appstore's own module object is never mutated — self-extension is pure too", () => {
    const before = JSON.stringify(appstore)
    const registry = new ModuleRegistry()
    registry.register(appstore)
    expect(JSON.stringify(appstore)).toBe(before)
  })
})

// docs/roadmaps/app-store.md, Phase 3: appstore extends its OWN already-
// registered '/appstore/:id' route to add the Views/Reports notebook pages —
// the same self-extension pattern core/modules/crm's Signature page proved.
describe('appstore — Views/Reports notebook pages (registry-level)', () => {
  function register(): ModuleRegistry {
    const registry = new ModuleRegistry()
    registry.register(appstore)
    return registry
  }

  it('the notebook is Views, Reports, then the (empty) synthesized Settings page, in that order', () => {
    const registry = register()
    const resolved = registry.buildRegistry().get('/appstore/:id')!
    const nodes = normalizeLayout(resolved.descriptor)
    const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    expect(notebook).toBeDefined()
    if (notebook && notebook.kind !== 'field') {
      expect(notebook.children.map((p) => (p.kind !== 'field' ? p.title : null))).toEqual([
        'Views',
        'Reports',
        'Settings',
      ])
    }
  })

  it('the Views page holds exactly the "views" field; the Reports page exactly "reports"', () => {
    const registry = register()
    const resolved = registry.buildRegistry().get('/appstore/:id')!
    const nodes = normalizeLayout(resolved.descriptor)
    const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    expect(notebook).toBeDefined()
    if (notebook && notebook.kind !== 'field') {
      const [views, reports, settings] = notebook.children
      if (views.kind !== 'field') {
        expect(views.children).toEqual([{ kind: 'field', name: 'views' }])
      }
      if (reports.kind !== 'field') {
        expect(reports.children).toEqual([{ kind: 'field', name: 'reports' }])
      }
      if (settings.kind !== 'field') {
        expect(settings.children).toEqual([])
      }
    }
  })

  it('"views" and "reports" resolve as store:false, widget:table fields with declared columns', () => {
    const registry = register()
    const resolved = registry.buildRegistry().get('/appstore/:id')!
    const byName = new Map(resolved.descriptor.fields.map((f) => [f.name, f]))
    const views = byName.get('views')
    expect(views?.widget).toBe('table')
    expect(views?.store).toBe(false)
    expect(views?.widgetOptions?.columns).toEqual([
      { key: 'route', label: 'Route' },
      { key: 'filename', label: 'Filename' },
      { key: 'filepath', label: 'Filepath' },
      { key: 'status', label: 'Status' },
    ])

    const reports = byName.get('reports')
    expect(reports?.widget).toBe('table')
    expect(reports?.store).toBe(false)
    expect(reports?.widgetOptions?.emptyLabel).toBe('Reports are not available yet.')
  })

  it('/appstore (the catalog) is untouched by the self-extension', () => {
    const registry = register()
    const catalog = registry.buildRegistry().get('/appstore')!
    expect(catalog.descriptor.fields.map((f) => f.name)).not.toContain('views')
    expect(catalog.descriptor.fields.map((f) => f.name)).not.toContain('reports')
  })
})
