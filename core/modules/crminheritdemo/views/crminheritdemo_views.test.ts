import { describe, expect, it } from 'vitest'
import {
  FORM_COLUMNS_ID,
  FORM_HEADER_ID,
  FORM_NOTEBOOK_ID,
  PAGE_SETTINGS_ID,
  layoutFieldOrder,
  ModuleRegistry,
  normalizeLayout,
} from '@eerp/core-front'

// This module's tsconfig mirrors contact/crm's — ES2022 lib only, no `dom`/`node` —
// so the ambient `console` global isn't declared. A minimal local shim, rather than
// widening the shared tsconfig template for one spy in one test.
declare const console: { warn: (...args: unknown[]) => void }
// Mirrors the Go side's `import "core/modules/crm"` in module.go: register the
// REAL crm module, then apply this module's extension on top — proving the
// merge end to end, not against a hand-rolled fixture.
import crm from '../../crm/views/crm_views'
import crminheritdemo from './crminheritdemo_views'

describe('crminheritdemo FrontModule', () => {
  it('ships no routes — it only extends already-registered ones', () => {
    expect(crminheritdemo.name).toBe('crminheritdemo')
    expect(crminheritdemo.routes).toEqual([])
  })

  it('extends both /crm/:id and /crm/list with the same four operations', () => {
    expect(crminheritdemo.extends?.map((e) => e.path)).toEqual(['/crm/:id', '/crm/list'])
    for (const ext of crminheritdemo.extends ?? []) {
      expect(ext.operations.map((op) => op.op)).toEqual(['addField', 'addField', 'move', 'setField'])
    }
  })
})

describe('crminheritdemo — resolved descriptor (registry-level)', () => {
  function registerBoth(): ModuleRegistry {
    const registry = new ModuleRegistry()
    registry.register(crm)
    registry.register(crminheritdemo, { depends: ['crm'] })
    return registry
  }

  it('the RESOLVED /crm/:id form gains date and comment in its field REGISTRY', () => {
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm/:id')
    const names = resolved?.descriptor.fields.map((f) => f.name) ?? []
    expect(names).toContain('date')
    expect(names).toContain('comment')
  })

  it('date lands right after status in DISPLAY (layout) order', () => {
    // comment's own placement (on the Settings page) is pinned by the
    // dedicated Settings-page test below, precisely rather than by "the very
    // last field overall" — crm now codes its OWN extra notebook page
    // ("Internal", views/crm_views.ts), appended after Settings, so comment
    // is no longer the last field in the fully flattened order. That's an
    // expected consequence of crm's own anatomy growing another page, not a
    // regression in this module's `date` placement.
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm/:id')!
    const order = layoutFieldOrder(normalizeLayout(resolved.descriptor))
    expect(order[order.indexOf('status') + 1]).toBe('date')
  })

  it('email moves to sit immediately after date in LAYOUT order — crm_views.ts\'s own fields[] declaration is untouched', () => {
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm/:id')!
    const order = layoutFieldOrder(normalizeLayout(resolved.descriptor))
    expect(order[order.indexOf('date') + 1]).toBe('email')
  })

  it('comment carries the hide-while-incoming state', () => {
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm/:id')!
    const comment = resolved.descriptor.fields.find((f) => f.name === 'comment')
    expect(comment?.states?.visible).toEqual({ field: 'status', op: 'ne', value: 'incoming' })
  })

  it('the base crm module still owns the resolved route — attribution is not stolen by the extender', () => {
    const registry = registerBoth()
    expect(registry.buildRegistry().get('/crm/:id')?.module).toBe('crm')
  })

  it('/crm/list is ALSO extended — date/comment columns, email reordered to sit after date', () => {
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm/list')!
    const names = resolved.descriptor.fields.map((f) => f.name)
    expect(names).toContain('date')
    expect(names).toContain('comment')
    const order = layoutFieldOrder(normalizeLayout(resolved.descriptor))
    expect(order[order.indexOf('date') + 1]).toBe('email')
  })

  it('the dashboard (/crm) is untouched — the extension targets only :id and list', () => {
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm')!
    expect(resolved.descriptor.fields.map((f) => f.name)).not.toContain('date')
  })

  it('email lands in __form_columns immediately after date, NOT in the header — retargeted so the header stays just picture+title', () => {
    // crminheritdemo's `move email` op originally targeted 'name' (the title
    // field), which put email INSIDE the synthesized header row alongside
    // the picture and the big title — three side-by-side items that
    // crowded the header at phone width (flagged, not fixed, when Phase 3
    // landed — see docs/roadmaps/responsive-displays.md). The op now
    // targets 'date' instead (itself inserted right after 'status' in
    // __form_columns via the 'date' addField above), so email joins the
    // two-column body instead — the header keeps exactly its intended two
    // items.
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm/:id')!
    const nodes = normalizeLayout(resolved.descriptor)

    const header = nodes.find((n) => n.kind !== 'field' && n.id === FORM_HEADER_ID)
    expect(header).toBeDefined()
    if (header && header.kind !== 'field') {
      const headerNames = header.children.map((c) => (c.kind === 'field' ? c.name : c.id))
      expect(headerNames).toEqual(['picture', 'name'])
    }

    const columns = nodes.find((n) => n.kind !== 'field' && n.id === FORM_COLUMNS_ID)
    expect(columns).toBeDefined()
    if (columns && columns.kind !== 'field') {
      const columnNames = columns.children.map((c) => (c.kind === 'field' ? c.name : c.id))
      expect(columnNames[columnNames.indexOf('date') + 1]).toBe('email')
    }
  })

  it('comment (widget: long, extension-added) lands on the default form\'s Settings page — zero extra wiring beyond declaring widget: "long" (docs/roadmaps/responsive-displays.md, Phase 4)', () => {
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm/:id')!
    const nodes = normalizeLayout(resolved.descriptor)
    const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
    expect(notebook).toBeDefined()
    if (notebook && notebook.kind !== 'field') {
      const settings = notebook.children.find((p) => p.kind !== 'field' && p.id === PAGE_SETTINGS_ID)
      expect(settings).toBeDefined()
      if (settings && settings.kind !== 'field') {
        const names = settings.children.map((c) => (c.kind === 'field' ? c.name : c.id))
        // crm's own `notes` (widget: long) plus this module's extension-added
        // `comment` (also widget: long) — both land here with no extra
        // wiring on either side.
        expect(names).toEqual(['notes', 'comment'])
      }
    }
  })

  it("crm's own module object is never mutated — applyExtension is pure", () => {
    const before = JSON.stringify(crm)
    registerBoth()
    expect(JSON.stringify(crm)).toBe(before)
  })

  it('registers cleanly with no depends-coverage warning (this module declares crm)', () => {
    const registry = new ModuleRegistry()
    registry.register(crm)
    let warned = false
    const original = console.warn
    console.warn = () => {
      warned = true
    }
    try {
      registry.register(crminheritdemo, { depends: ['crm'] })
    } finally {
      console.warn = original
    }
    expect(warned).toBe(false)
  })
})
