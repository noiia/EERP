import { describe, expect, it } from 'vitest'
import {
  behaviorRegistry,
  FORM_COLUMNS_ID,
  FORM_NOTEBOOK_ID,
  ModuleRegistry,
  headerButtonRegistry,
  normalizeLayout,
  type HeaderButtonContext,
  type RelationOps,
} from '@eerp/core-front'
import propertymanagement from './PropertyManagementViews'

// The module's contribution is descriptors + route wiring; assert it stays correct.
describe('propertymanagement FrontModule', () => {
  it('is named "propertymanagement" and exposes the property/receipt routes', () => {
    expect(propertymanagement.name).toBe('propertymanagement')
    expect(propertymanagement.routes.map((r) => r.path)).toEqual([
      '/propertymanagement',
      '/propertymanagement/list',
      '/propertymanagement/:id',
      '/propertymanagement/equipment/:id',
      '/propertymanagement/equipment/statuses/:id',
      '/propertymanagement/receipts',
      '/propertymanagement/receipts/:id',
    ])
  })

  it('wires a dashboard, a tree list, and a form, all over the property_management entity', () => {
    const dashboard = propertymanagement.routes.find((r) => r.path === '/propertymanagement')!
    const list = propertymanagement.routes.find((r) => r.path === '/propertymanagement/list')!
    const form = propertymanagement.routes.find((r) => r.path === '/propertymanagement/:id')!
    expect(dashboard.descriptor.entity).toBe('property_management')
    expect(list.descriptor.entity).toBe('property_management')
    expect(form.descriptor.entity).toBe('property_management')
    expect(dashboard.descriptor.viewType).toBe('dashboard')
    expect(list.descriptor.viewType).toBe('tree')
    expect(form.descriptor.viewType).toBe('form')
  })

  it('makes list rows open the property form', () => {
    const list = propertymanagement.routes.find((r) => r.path === '/propertymanagement/list')!
    expect(list.descriptor.formPath).toBe('/propertymanagement/:id')
  })

  it('guards property_management routes with property_management:property_management:read', () => {
    for (const path of ['/propertymanagement', '/propertymanagement/list', '/propertymanagement/:id']) {
      expect(propertymanagement.routes.find((r) => r.path === path)?.permission).toBe(
        'property_management:property_management:read',
      )
    }
  })

  it('current_tenant is a many2many over contact via property_management_tenant', () => {
    const form = propertymanagement.routes.find((r) => r.path === '/propertymanagement/:id')!
    const field = form.descriptor.fields.find((f) => f.name === 'current_tenant')
    expect(field?.relation).toEqual({
      entity: 'contact',
      kind: 'many2many',
      via: 'property_management_tenant',
      viaFields: { own: 'property_management_id', related: 'contact_id' },
      labelField: 'name',
    })
  })

  it('photos is a relation/carousel one2many over property_management_photo, capped at 20', () => {
    const form = propertymanagement.routes.find((r) => r.path === '/propertymanagement/:id')!
    const field = form.descriptor.fields.find((f) => f.name === 'photos')
    expect(field?.widget).toBe('carousel')
    expect(field?.widgetOptions).toEqual({ max: 20 })
    expect(field?.relation).toEqual({
      entity: 'property_management_photo',
      kind: 'one2many',
      inverseField: 'property_management_id',
    })
  })

  it('equipment is a one2many over property_management_equipment with a click-through formPath', () => {
    const form = propertymanagement.routes.find((r) => r.path === '/propertymanagement/:id')!
    const field = form.descriptor.fields.find((f) => f.name === 'equipment')
    expect(field?.relation?.formPath).toBe('/propertymanagement/equipment/:id')
  })

  it('rent_receipts is read-only, one2many over property_management_rent_receipt', () => {
    const form = propertymanagement.routes.find((r) => r.path === '/propertymanagement/:id')!
    const field = form.descriptor.fields.find((f) => f.name === 'rent_receipts')
    expect(field?.readOnly).toBe(true)
    expect(field?.relation?.entity).toBe('property_management_rent_receipt')
    expect(field?.relation?.formPath).toBe('/propertymanagement/receipts/:id')
  })

  it('wires the Generate Rent Receipt header button, disabled once already run this month', () => {
    const form = propertymanagement.routes.find((r) => r.path === '/propertymanagement/:id')!
    expect(form.descriptor.headerButtons).toEqual([
      {
        name: 'propertymanagement.generateRentReceipt',
        label: 'Generate Rent Receipt',
        states: { readOnly: { field: 'receipt_generated_this_month', op: 'eq', value: true } },
      },
    ])
  })
})

describe('/propertymanagement/receipts — every generated receipt', () => {
  function list() {
    return propertymanagement.routes.find((r) => r.path === '/propertymanagement/receipts')!
  }

  it('is a tree list over property_management_rent_receipt, navigable to the receipt form', () => {
    expect(list().descriptor.entity).toBe('property_management_rent_receipt')
    expect(list().descriptor.viewType).toBe('tree')
    expect(list().descriptor.formPath).toBe('/propertymanagement/receipts/:id')
    expect(list().permission).toBe('property_management_rent_receipt:property_management_rent_receipt:read')
  })

  it('has no createPermission — a receipt is append-only, never manually created', () => {
    expect(list().descriptor.createPermission).toBeUndefined()
  })

  it('shows the same snapshot fields as the receipt form, including receipt_file', () => {
    expect(list().descriptor.fields.map((f) => f.name)).toEqual(
      propertymanagement.routes
        .find((r) => r.path === '/propertymanagement/receipts/:id')!
        .descriptor.fields.map((f) => f.name),
    )
  })
})

describe('propertymanagement.regenerateReceiptPdf', () => {
  function receiptForm() {
    return propertymanagement.routes.find((r) => r.path === '/propertymanagement/receipts/:id')!
  }

  it('wires a Regenerate PDF header button, visible only while receipt_file is false', () => {
    expect(receiptForm().descriptor.headerButtons).toEqual([
      {
        name: 'propertymanagement.regenerateReceiptPdf',
        label: 'Regenerate PDF',
        states: { visible: { field: 'receipt_file', op: 'eq', value: false } },
      },
    ])
  })

  it('is registered against property_management_rent_receipt', () => {
    const registered = headerButtonRegistry.get('propertymanagement.regenerateReceiptPdf')
    expect(registered?.entity).toBe('property_management_rent_receipt')
  })
})

describe('propertymanagement — self-extended notebook pages (registry-level)', () => {
  function register(): ModuleRegistry {
    const registry = new ModuleRegistry()
    registry.register(propertymanagement)
    return registry
  }

  it('Photos/Equipment/Rent receipt each land on their own notebook tab', () => {
    const registry = register()
    const resolved = registry.buildRegistry().get('/propertymanagement/:id')!
    const nodes = normalizeLayout(resolved.descriptor)
    const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    expect(notebook).toBeDefined()
    if (!notebook || notebook.kind === 'field') return
    const titles = notebook.children.map((p) => (p.kind !== 'field' ? p.title : null))
    expect(titles).toEqual(['Rent receipt', 'Equipment', 'Photos', 'Settings'])
    const photosPage = notebook.children.find((p) => p.kind !== 'field' && p.title === 'Photos')
    if (photosPage && photosPage.kind !== 'field') {
      expect(photosPage.children).toEqual([{ kind: 'field', name: 'photos' }])
    }
  })

  it('/propertymanagement/list is untouched — the extension targets only :id', () => {
    const registry = register()
    expect(
      registry.buildRegistry().get('/propertymanagement/list')?.descriptor.fields.map((f) => f.name),
    ).not.toContain('equipment')
  })
})

describe('propertymanagement — equipment form', () => {
  function equipmentForm() {
    return propertymanagement.routes.find((r) => r.path === '/propertymanagement/equipment/:id')!
  }

  it('property_management_id renders as a read-only relation/summary recap, not the stock picker', () => {
    const field = equipmentForm().descriptor.fields.find((f) => f.name === 'property_management_id')
    expect(field?.widget).toBe('summary')
    expect(field?.required).toBe(true)
    expect(field?.widgetOptions).toEqual({
      fields: ['name', 'address_city'],
      relatedRelationField: 'current_tenant',
      relatedRelationLabel: 'Tenant',
    })
    expect(field?.relation).toEqual({ entity: 'property_management', kind: 'many2one', labelField: 'name' })
  })

  it('statuses is a one2many over property_management_equipment_status with a click-through formPath', () => {
    const field = equipmentForm().descriptor.fields.find((f) => f.name === 'statuses')
    expect(field?.relation?.entity).toBe('property_management_equipment_status')
    expect(field?.relation?.formPath).toBe('/propertymanagement/equipment/statuses/:id')
  })

  it('photos is a relation/carousel one2many over property_management_equipment_photo, capped at 10', () => {
    const field = equipmentForm().descriptor.fields.find((f) => f.name === 'photos')
    expect(field?.widget).toBe('carousel')
    expect(field?.widgetOptions).toEqual({ max: 10 })
    expect(field?.relation).toEqual({
      entity: 'property_management_equipment_photo',
      kind: 'one2many',
      inverseField: 'property_management_equipment_id',
    })
  })

  it('registers propertymanagement.equipmentAge as a live (store:false) compute off buying_date', () => {
    const fn = behaviorRegistry.fieldFunction('propertymanagement.equipmentAge')
    expect(fn?.depends).toEqual(['buying_date'])
    expect(fn?.handler({})).toBe('')
    expect(fn?.handler({ buying_date: 'not-a-date' })).toBe('')

    // Fixed day-offsets (not setFullYear/setMonth) so the expectation never
    // rides on calendar month-length variance — floor(days/365.25) and
    // floor(days/30.44) are exact for these round numbers.
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    expect(fn?.handler({ buying_date: daysAgo(800) })).toBe('2 years old')
    expect(fn?.handler({ buying_date: daysAgo(100) })).toBe('3 months old')

    const field = equipmentForm().descriptor.fields.find((f) => f.name === 'buying_age')
    expect(field?.compute).toBe('propertymanagement.equipmentAge')
    expect(field?.store).toBe(false)
  })

  it('self-extension puts buying_date/buying_age in one row and Equipped in / Damage state history / Photos on their own tabs', () => {
    const registry = new ModuleRegistry()
    registry.register(propertymanagement)
    const resolved = registry.buildRegistry().get('/propertymanagement/equipment/:id')!
    const nodes = normalizeLayout(resolved.descriptor)

    const columns = nodes.find((n) => n.kind !== 'field' && n.id === FORM_COLUMNS_ID)
    expect(columns && columns.kind !== 'field' ? columns.children.at(-1) : null).toEqual({
      kind: 'row',
      children: [{ kind: 'field', name: 'buying_date' }, { kind: 'field', name: 'buying_age' }],
    })

    const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    expect(notebook).toBeDefined()
    if (!notebook || notebook.kind === 'field') return
    expect(notebook.children.map((p) => (p.kind !== 'field' ? p.title : null))).toEqual([
      'Equipped in',
      'Damage state history',
      'Photos',
      'Settings',
    ])
  })
})

describe('propertymanagement.generateRentReceipt', () => {
  function context(overrides: Partial<HeaderButtonContext> = {}): HeaderButtonContext {
    return {
      entity: 'property_management',
      recordId: 'p1',
      draft: { name: 'Sunset Apartments', address_number: 12, address_street: 'Main Street' },
      setFieldAndCommit: async (patch) => ({ id: 'p1', ...patch }),
      relationOps: null,
      ...overrides,
    }
  }

  it('does nothing without a wired RelationOpsProvider', async () => {
    let committed = false
    const ctx = context({
      relationOps: null,
      setFieldAndCommit: async (patch) => {
        committed = true
        return { id: 'p1', ...patch }
      },
    })
    await headerButtonRegistry.get('propertymanagement.generateRentReceipt')!.handler(ctx)
    expect(committed).toBe(false)
  })

  it('creates this month\'s receipt snapshotting the property/tenants, then sets last_receipt_month', async () => {
    const created: { entity: string; body: Record<string, unknown> }[] = []
    const ops: RelationOps = {
      list: async (entity) =>
        entity === 'property_management_tenant' ? [{ id: 'link1', contact_id: 'c1' }] : [],
      get: async (entity, id) => (entity === 'contact' && id === 'c1' ? { id: 'c1', name: 'Jane Doe' } : { id }),
      create: async (entity, body) => {
        created.push({ entity, body })
        return { id: 'r1', ...body }
      },
      remove: async () => {},
    }
    const committed: Record<string, unknown>[] = []
    const ctx = context({
      relationOps: ops,
      setFieldAndCommit: async (patch) => {
        committed.push(patch)
        return { id: 'p1', ...patch }
      },
    })

    await headerButtonRegistry.get('propertymanagement.generateRentReceipt')!.handler(ctx)

    const period = new Date().toISOString().slice(0, 7)
    expect(created).toEqual([
      {
        entity: 'property_management_rent_receipt',
        body: expect.objectContaining({
          property_management_id: 'p1',
          period,
          property_name: 'Sunset Apartments',
          property_address: '12 Main Street',
          tenant_names: 'Jane Doe',
        }),
      },
    ])
    expect(committed).toEqual([{ last_receipt_month: period }])
  })
})
