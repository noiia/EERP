import type { FieldDescriptor, ViewDescriptor } from './descriptor'

// The field behavior layer (docs/roadmaps/field-widgets.md, Phase 2). Descriptors
// stay DATA — they cross the RSC boundary, so a field references its compute
// function by NAME (`compute: 'crm.margin'`) and the code lives here, in a client
// registry the module's views file populates at import time:
//
//   registerFieldFunction({ entity: 'crm', name: 'crm.margin',
//     depends: ['price', 'cost'], handler: (d) => margin(d) })
//   registerOnChange({ entity: 'crm', name: 'crm.countryDefaults',
//     onChange: ['country'], handler: (d) => ({ currency: currencyOf(d) }) })
//
// The form store fires on_change handlers when a listed field changes (their patch
// merges into the draft), then recomputes every computed field whose `depends`
// intersect the changed keys — in dependency order, with cycles rejected when the
// plan is built (module registration / store creation), never at edit time.

/** The draft shape behavior handlers see: a plain record, never a store. */
export type DraftRecord = Record<string, unknown>

export interface FieldFunction {
  /** Entity the function belongs to — must match the descriptor's entity. */
  entity: string
  /** Globally unique name a field's `compute` references (convention: '<entity>.<what>'). */
  name: string
  /** Field names whose draft edits trigger a recompute. */
  depends: string[]
  /** Pure computation over the draft; the return value becomes the field's value. */
  handler: (draft: Readonly<DraftRecord>) => unknown
}

export interface OnChangeHandler {
  entity: string
  name: string
  /** Field names whose draft edits fire the handler. */
  onChange: string[]
  /** Returns a partial draft patch to merge (or nothing). */
  handler: (draft: Readonly<DraftRecord>) => Partial<DraftRecord> | void
}

class BehaviorRegistry {
  private readonly functions = new Map<string, FieldFunction>()
  private readonly onChangeHandlers: OnChangeHandler[] = []

  registerFieldFunction(fn: FieldFunction): void {
    if (this.functions.has(fn.name)) {
      throw new Error(`field function "${fn.name}" is already registered`)
    }
    this.functions.set(fn.name, fn)
  }

  registerOnChange(handler: OnChangeHandler): void {
    if (this.onChangeHandlers.some((h) => h.name === handler.name)) {
      throw new Error(`on_change handler "${handler.name}" is already registered`)
    }
    this.onChangeHandlers.push(handler)
  }

  fieldFunction(name: string): FieldFunction | undefined {
    return this.functions.get(name)
  }

  onChangeFor(entity: string): OnChangeHandler[] {
    return this.onChangeHandlers.filter((h) => h.entity === entity)
  }

  /** Test-only: forget everything (mirrors translationRegistry.clear()). */
  clear(): void {
    this.functions.clear()
    this.onChangeHandlers.length = 0
  }
}

/** The shared registry module views files populate at import time. */
export const behaviorRegistry = new BehaviorRegistry()

/** Register a compute function (see FieldFunction). Import-time, client-safe. */
export function registerFieldFunction(fn: FieldFunction): void {
  behaviorRegistry.registerFieldFunction(fn)
}

/** Register an on_change handler (see OnChangeHandler). Import-time, client-safe. */
export function registerOnChange(handler: OnChangeHandler): void {
  behaviorRegistry.registerOnChange(handler)
}

// ── the per-descriptor plan ───────────────────────────────────────────────────

interface ComputedField {
  field: FieldDescriptor
  fn: FieldFunction
}

export interface BehaviorPlan {
  /** Computed fields in dependency order (a compute feeding another runs first). */
  computed: ComputedField[]
  /** The descriptor entity's on_change handlers. */
  onChange: OnChangeHandler[]
  /** Names of store:false fields — stripped from every commit payload. */
  unstored: string[]
}

/**
 * Resolve a descriptor's behaviors against the registry: look up every field's
 * compute function, order computed fields so dependencies run first, and reject
 * cycles / unknown names / entity mismatches with errors naming the field. Called
 * at module registration (fail the build) and at form-store creation.
 */
export function buildBehaviorPlan<T>(descriptor: ViewDescriptor<T>): BehaviorPlan {
  const computed: ComputedField[] = []
  for (const field of descriptor.fields) {
    if (!field.compute) continue
    const fn = behaviorRegistry.fieldFunction(field.compute)
    if (!fn) {
      throw new Error(
        `field "${field.name}": compute function "${field.compute}" is not registered`,
      )
    }
    if (fn.entity !== descriptor.entity) {
      throw new Error(
        `field "${field.name}": compute function "${field.compute}" belongs to entity ` +
          `"${fn.entity}", not "${descriptor.entity}"`,
      )
    }
    computed.push({ field, fn })
  }

  // Topological order over "computed field A depends on computed field B" edges.
  const byName = new Map(computed.map((c) => [c.field.name, c]))
  const ordered: ComputedField[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (c: ComputedField, chain: string[]) => {
    const mark = state.get(c.field.name)
    if (mark === 'done') return
    if (mark === 'visiting') {
      throw new Error(
        `compute cycle: ${[...chain, c.field.name].join(' -> ')} — computed fields may not ` +
          'depend on each other circularly',
      )
    }
    state.set(c.field.name, 'visiting')
    for (const dep of c.fn.depends) {
      const upstream = byName.get(dep)
      if (upstream) visit(upstream, [...chain, c.field.name])
    }
    state.set(c.field.name, 'done')
    ordered.push(c)
  }
  for (const c of computed) visit(c, [])

  return {
    computed: ordered,
    onChange: behaviorRegistry.onChangeFor(descriptor.entity),
    unstored: descriptor.fields.filter((f) => f.store === false).map((f) => f.name),
  }
}

/**
 * Apply behaviors to a draft after `changed` keys were edited: fire matching
 * on_change handlers once each (their patches join the changed set), then run the
 * compute plan — a computed field recomputes when its depends intersect the changed
 * set, and its own change propagates to downstream computes. Pure: returns a new
 * draft. `changed = null` means "everything" (initial seed: compute all fields so
 * display-only values exist before the first edit).
 */
export function applyBehaviors(
  plan: BehaviorPlan,
  draft: DraftRecord,
  changed: string[] | null,
): DraftRecord {
  const next: DraftRecord = { ...draft }
  const changedSet = changed === null ? null : new Set(changed)

  for (const handler of plan.onChange) {
    if (changedSet !== null && !handler.onChange.some((k) => changedSet.has(k))) continue
    const patch = handler.handler(next)
    if (!patch) continue
    for (const [key, value] of Object.entries(patch)) {
      if (next[key] !== value) {
        next[key] = value
        changedSet?.add(key)
      }
    }
  }

  for (const { field, fn } of plan.computed) {
    if (changedSet !== null && !fn.depends.some((k) => changedSet.has(k))) continue
    const value = fn.handler(next)
    if (next[field.name] !== value) {
      next[field.name] = value
      changedSet?.add(field.name)
    }
  }

  return next
}

/** Drop store:false fields from a commit payload (they have no DB column). */
export function stripUnstored<T>(draft: Partial<T>, unstored: string[]): Partial<T> {
  if (unstored.length === 0) return draft
  const payload = { ...draft } as DraftRecord
  for (const name of unstored) delete payload[name]
  return payload as Partial<T>
}
