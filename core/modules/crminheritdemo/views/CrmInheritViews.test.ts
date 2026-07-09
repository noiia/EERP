import { describe, expect, it } from 'vitest'
import { layoutFieldOrder, ModuleRegistry, normalizeLayout } from '@eerp/core-front'

// This module's tsconfig mirrors contact/crm's — ES2022 lib only, no `dom`/`node` —
// so the ambient `console` global isn't declared. A minimal local shim, rather than
// widening the shared tsconfig template for one spy in one test.
declare const console: { warn: (...args: unknown[]) => void }
// Mirrors the Go side's `import "core/modules/crm"` in module.go: register the
// REAL crm module, then apply this module's extension on top — proving the
// merge end to end, not against a hand-rolled fixture.
import crm from '../../crm/views/CrmViews'
import crminheritdemo from './CrmInheritViews'

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

  it('date lands right after status and comment at the very end — in DISPLAY (layout) order', () => {
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm/:id')!
    const order = layoutFieldOrder(normalizeLayout(resolved.descriptor))
    expect(order[order.indexOf('status') + 1]).toBe('date')
    expect(order[order.length - 1]).toBe('comment')
  })

  it('email moves before name in LAYOUT order — CrmViews.ts\'s own fields[] declaration is untouched', () => {
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm/:id')!
    const order = layoutFieldOrder(normalizeLayout(resolved.descriptor))
    expect(order.indexOf('email')).toBeLessThan(order.indexOf('name'))
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

  it('/crm/list is ALSO extended — date/comment columns, email/name reordered', () => {
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm/list')!
    const names = resolved.descriptor.fields.map((f) => f.name)
    expect(names).toContain('date')
    expect(names).toContain('comment')
    const order = layoutFieldOrder(normalizeLayout(resolved.descriptor))
    expect(order.indexOf('email')).toBeLessThan(order.indexOf('name'))
  })

  it('the dashboard (/crm) is untouched — the extension targets only :id and list', () => {
    const registry = registerBoth()
    const resolved = registry.buildRegistry().get('/crm')!
    expect(resolved.descriptor.fields.map((f) => f.name)).not.toContain('date')
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
