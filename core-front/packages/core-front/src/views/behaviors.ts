import {
  addressSubKey,
  addressSubZeroDefault,
  ADDRESS_SUFFIXES,
  fieldZeroDefault,
  isVirtualRelation,
  type FieldDescriptor,
  type ViewDescriptor,
} from './descriptor'

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

interface FieldDefault {
  name: string
  /** Produces the seed value; sees the (partially defaulted) seed draft. */
  resolve: (draft: Readonly<DraftRecord>) => unknown
}

export interface BehaviorPlan {
  /** Computed fields in dependency order (a compute feeding another runs first). */
  computed: ComputedField[]
  /** The descriptor entity's on_change handlers. */
  onChange: OnChangeHandler[]
  /** Names of store:false fields — stripped from every commit payload. */
  unstored: string[]
  /** Per-field seed defaults (declared `default` or the type's zero value). */
  defaults: FieldDefault[]
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
    // store:false fields, virtual relations (o2m/m2m), and type:'address'
    // fields: none of the three has a column on this record under their OWN
    // name (address owns SIBLING columns instead — descriptor.ts's FIELD_WIDGETS
    // doc comment), so none may reach the commit payload. address is always
    // unstored regardless of the module's own `store` declaration, same
    // "the type itself decides, not the flag" posture o2m/m2m relations have.
    unstored: descriptor.fields
      .filter((f) => f.store === false || isVirtualRelation(f) || f.type === 'address')
      .map((f) => f.name),
    defaults: buildDefaults(descriptor),
  }
}

/**
 * Resolve every field's seed default once, at plan build. A declared `default`
 * that is a string is first looked up in the function registry: registered →
 * it's a function default (entity-checked, like compute); unregistered → a
 * literal string. Virtual relations (o2m/m2m) get no default — no column.
 */
function buildDefaults<T>(descriptor: ViewDescriptor<T>): FieldDefault[] {
  const defaults: FieldDefault[] = []
  for (const field of descriptor.fields) {
    if (isVirtualRelation(field)) continue
    // type: 'address' owns 7 SIBLING columns, not its own — none of them
    // get a default from the loop below (the field's own default resolves
    // to the unstored 'address' key itself, per fieldZeroDefault). Without
    // this, a record saved without ever touching the widget omits every
    // sibling key from the commit payload entirely; Go's generic Create
    // 422s (VALIDATION_ERROR) because the NOT NULL string sub-columns
    // never arrived in the body at all — this is what actually keeps them
    // present (even as '') on every commit, not just once the user edits.
    if (field.type === 'address') {
      for (const suffix of ADDRESS_SUFFIXES) {
        const key = addressSubKey(field.name, suffix)
        const zero = addressSubZeroDefault(suffix)
        defaults.push({ name: key, resolve: () => zero })
      }
    }
    if (field.default === undefined) {
      const zero = fieldZeroDefault(field)
      defaults.push({ name: field.name, resolve: () => zero })
      continue
    }
    const declared = field.default
    const fn = typeof declared === 'string' ? behaviorRegistry.fieldFunction(declared) : undefined
    if (fn) {
      if (fn.entity !== descriptor.entity) {
        throw new Error(
          `field "${field.name}": default function "${fn.name}" belongs to entity ` +
            `"${fn.entity}", not "${descriptor.entity}"`,
        )
      }
      defaults.push({ name: field.name, resolve: (draft) => fn.handler(draft) })
    } else {
      defaults.push({ name: field.name, resolve: () => declared })
    }
  }
  return defaults
}

/**
 * Fill the seed draft's missing fields (strictly `undefined` — an explicit null
 * from the server is a value) with their plan defaults. Runs BEFORE the seed
 * compute pass, so defaulted inputs feed computes; runs on every seed (new
 * record, edit, post-commit reconcile) and is a no-op for keys the record
 * carries — server values are never overwritten. Pure: returns a new draft.
 */
export function seedDefaults(plan: BehaviorPlan, draft: DraftRecord): DraftRecord {
  const next: DraftRecord = { ...draft }
  for (const d of plan.defaults) {
    if (next[d.name] === undefined) next[d.name] = d.resolve(next)
  }
  return next
}

/**
 * Apply behaviors to a draft after `changed` keys were edited: fire matching
 * on_change handlers once each (their patches join the changed set), then run the
 * compute plan — a computed field recomputes when its depends intersect the changed
 * set, and its own change propagates to downstream computes. Pure: returns a new
 * draft.
 *
 * `changed = null` is a COMPUTE-ONLY pass: every computed field recomputes
 * unconditionally (so store:false display values exist before the first edit,
 * and survive re-seeding an existing record / the post-commit reconcile), but
 * on_change handlers never fire. on_change reacts to the user changing a
 * field — loading a record that already has a value, or re-seeding with what
 * Go just returned, is not an edit, and firing here would silently overwrite a
 * value the user explicitly set (or that was just saved) with a fresh
 * suggestion. A brand-new record's initial suggestions come from
 * createFormStore passing the full defaulted key set instead of null — the
 * same code path as if the user had just filled in every default.
 */
export function applyBehaviors(
  plan: BehaviorPlan,
  draft: DraftRecord,
  changed: string[] | null,
): DraftRecord {
  const next: DraftRecord = { ...draft }
  const changedSet = changed === null ? null : new Set(changed)

  if (changedSet !== null) {
    for (const handler of plan.onChange) {
      if (!handler.onChange.some((k) => changedSet.has(k))) continue
      const patch = handler.handler(next)
      if (!patch) continue
      for (const [key, value] of Object.entries(patch)) {
        if (next[key] !== value) {
          next[key] = value
          changedSet.add(key)
        }
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
