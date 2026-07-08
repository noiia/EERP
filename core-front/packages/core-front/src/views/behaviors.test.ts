import { afterEach, describe, expect, it } from 'vitest'
import {
  applyBehaviors,
  behaviorRegistry,
  buildBehaviorPlan,
  registerFieldFunction,
  registerOnChange,
  seedDefaults,
  stripUnstored,
} from './behaviors'
import type { FieldDescriptor, ViewDescriptor } from './descriptor'

afterEach(() => {
  behaviorRegistry.clear()
})

const num = (name: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  name,
  label: name,
  type: 'number',
  ...extra,
})

function descriptor(fields: FieldDescriptor[]): ViewDescriptor {
  return { entity: 'crm', viewType: 'form', fields }
}

describe('buildBehaviorPlan', () => {
  it('orders computed fields so upstream computes run first', () => {
    registerFieldFunction({
      entity: 'crm',
      name: 'crm.total',
      depends: ['subtotal'], // subtotal is itself computed
      handler: (d) => (d.subtotal as number) * 1.2,
    })
    registerFieldFunction({
      entity: 'crm',
      name: 'crm.subtotal',
      depends: ['qty', 'price'],
      handler: (d) => (d.qty as number) * (d.price as number),
    })
    const plan = buildBehaviorPlan(
      descriptor([
        num('qty'),
        num('price'),
        num('total', { compute: 'crm.total' }), // declared BEFORE its dependency
        num('subtotal', { compute: 'crm.subtotal' }),
      ]),
    )
    expect(plan.computed.map((c) => c.field.name)).toEqual(['subtotal', 'total'])
  })

  it('rejects a compute cycle, naming the chain', () => {
    registerFieldFunction({ entity: 'crm', name: 'crm.a', depends: ['b'], handler: () => 0 })
    registerFieldFunction({ entity: 'crm', name: 'crm.b', depends: ['a'], handler: () => 0 })
    expect(() =>
      buildBehaviorPlan(
        descriptor([num('a', { compute: 'crm.a' }), num('b', { compute: 'crm.b' })]),
      ),
    ).toThrowError(/compute cycle/)
  })

  it('rejects an unregistered compute name, naming the field', () => {
    expect(() => buildBehaviorPlan(descriptor([num('x', { compute: 'crm.nope' })]))).toThrowError(
      /field "x".*"crm\.nope" is not registered/,
    )
  })

  it('rejects a compute function registered for another entity', () => {
    registerFieldFunction({ entity: 'inventory', name: 'inv.x', depends: [], handler: () => 0 })
    expect(() => buildBehaviorPlan(descriptor([num('x', { compute: 'inv.x' })]))).toThrowError(
      /belongs to entity "inventory", not "crm"/,
    )
  })

  it('rejects duplicate registrations', () => {
    registerFieldFunction({ entity: 'crm', name: 'crm.a', depends: [], handler: () => 0 })
    expect(() =>
      registerFieldFunction({ entity: 'crm', name: 'crm.a', depends: [], handler: () => 0 }),
    ).toThrowError(/already registered/)
    registerOnChange({ entity: 'crm', name: 'crm.oc', onChange: ['x'], handler: () => undefined })
    expect(() =>
      registerOnChange({ entity: 'crm', name: 'crm.oc', onChange: ['x'], handler: () => undefined }),
    ).toThrowError(/already registered/)
  })
})

describe('applyBehaviors', () => {
  it('recomputes a depends chain in order after one edit', () => {
    registerFieldFunction({
      entity: 'crm',
      name: 'crm.subtotal',
      depends: ['qty', 'price'],
      handler: (d) => ((d.qty as number) ?? 0) * ((d.price as number) ?? 0),
    })
    registerFieldFunction({
      entity: 'crm',
      name: 'crm.total',
      depends: ['subtotal'],
      handler: (d) => ((d.subtotal as number) ?? 0) * 1.2,
    })
    const plan = buildBehaviorPlan(
      descriptor([
        num('qty'),
        num('price'),
        num('subtotal', { compute: 'crm.subtotal' }),
        num('total', { compute: 'crm.total' }),
      ]),
    )
    const next = applyBehaviors(plan, { qty: 2, price: 10, subtotal: 0, total: 0 }, ['price'])
    expect(next.subtotal).toBe(20)
    expect(next.total).toBe(24)
  })

  it('skips computes whose depends did not change', () => {
    let calls = 0
    registerFieldFunction({
      entity: 'crm',
      name: 'crm.subtotal',
      depends: ['qty'],
      handler: (d) => {
        calls++
        return (d.qty as number) * 2
      },
    })
    const plan = buildBehaviorPlan(
      descriptor([num('qty'), num('name'), num('subtotal', { compute: 'crm.subtotal' })]),
    )
    applyBehaviors(plan, { qty: 1 }, ['name'])
    expect(calls).toBe(0)
  })

  it('an on_change patch cascades into dependent computes', () => {
    registerOnChange({
      entity: 'crm',
      name: 'crm.countryDefaults',
      onChange: ['country'],
      handler: (d) => ({ vat_rate: d.country === 'FR' ? 0.2 : 0 }),
    })
    registerFieldFunction({
      entity: 'crm',
      name: 'crm.vat',
      depends: ['price', 'vat_rate'],
      handler: (d) => ((d.price as number) ?? 0) * ((d.vat_rate as number) ?? 0),
    })
    const plan = buildBehaviorPlan(
      descriptor([
        num('country'),
        num('price'),
        num('vat_rate'),
        num('vat', { compute: 'crm.vat' }),
      ]),
    )
    const next = applyBehaviors(plan, { country: 'FR', price: 100 }, ['country'])
    expect(next.vat_rate).toBe(0.2)
    expect(next.vat).toBe(20)
  })

  it('changed = null (seed) computes everything', () => {
    registerFieldFunction({
      entity: 'crm',
      name: 'crm.double',
      depends: ['qty'],
      handler: (d) => ((d.qty as number) ?? 0) * 2,
    })
    const plan = buildBehaviorPlan(descriptor([num('qty'), num('double', { compute: 'crm.double' })]))
    expect(applyBehaviors(plan, { qty: 3 }, null).double).toBe(6)
  })

  it('changed = null NEVER fires on_change — a compute-only pass', () => {
    // Regression: loading an existing record (or the post-commit reconcile)
    // must not let an on_change re-derive a value the user already set —
    // e.g. re-suggesting `score` from `status` would silently overwrite
    // whatever star rating was actually saved.
    registerOnChange({
      entity: 'crm',
      name: 'crm.scoreFromStatus',
      onChange: ['status'],
      handler: (d) => ({ score: d.status === 'customer' ? 3 : 1 }),
    })
    const plan = buildBehaviorPlan(descriptor([num('status'), num('score')]))
    const next = applyBehaviors(plan, { status: 'customer', score: 0 }, null)
    expect(next.score).toBe(0) // untouched — not re-suggested
  })

  it('an explicit changed key list DOES fire on_change, unlike null', () => {
    registerOnChange({
      entity: 'crm',
      name: 'crm.scoreFromStatus',
      onChange: ['status'],
      handler: (d) => ({ score: d.status === 'customer' ? 3 : 1 }),
    })
    const plan = buildBehaviorPlan(descriptor([num('status'), num('score')]))
    const next = applyBehaviors(plan, { status: 'customer', score: 0 }, ['status'])
    expect(next.score).toBe(3)
  })
})

describe('seedDefaults', () => {
  it('fills missing fields with the type zero defaults', () => {
    const plan = buildBehaviorPlan(
      descriptor([
        { name: 'name', type: 'text' },
        { name: 'qty', type: 'number' },
        { name: 'active', type: 'boolean' },
        { name: 'due', type: 'date' },
        {
          name: 'contact_id',
          type: 'relation',
          relation: { entity: 'contact', kind: 'many2one' },
        },
      ]),
    )
    expect(seedDefaults(plan, {})).toEqual({
      name: '',
      qty: 0,
      active: false,
      due: null,
      contact_id: null,
    })
  })

  it('a declared literal default wins over the zero default', () => {
    const plan = buildBehaviorPlan(
      descriptor([
        { name: 'status', type: 'text', default: 'lead' },
        { name: 'priority', type: 'number', default: 2 },
      ]),
    )
    expect(seedDefaults(plan, {})).toEqual({ status: 'lead', priority: 2 })
  })

  it('a string default naming a registered function is called with the seed draft', () => {
    registerFieldFunction({
      entity: 'crm',
      name: 'crm.defaultQty',
      depends: [],
      handler: (d) => (d.bulk ? 100 : 1),
    })
    const plan = buildBehaviorPlan(
      descriptor([
        { name: 'bulk', type: 'boolean' },
        { name: 'qty', type: 'number', default: 'crm.defaultQty' },
      ]),
    )
    expect(seedDefaults(plan, { bulk: true }).qty).toBe(100)
    expect(seedDefaults(plan, {}).qty).toBe(1)
  })

  it('a string default matching no registered function stays a literal', () => {
    const plan = buildBehaviorPlan(descriptor([{ name: 'status', type: 'text', default: 'lead' }]))
    expect(seedDefaults(plan, {}).status).toBe('lead')
  })

  it('rejects a default function registered for another entity', () => {
    registerFieldFunction({ entity: 'inventory', name: 'inv.d', depends: [], handler: () => 1 })
    expect(() =>
      buildBehaviorPlan(descriptor([{ name: 'qty', type: 'number', default: 'inv.d' }])),
    ).toThrowError(/default function "inv\.d" belongs to entity "inventory", not "crm"/)
  })

  it('never overwrites values the record carries — an explicit null is a value', () => {
    const plan = buildBehaviorPlan(
      descriptor([
        { name: 'name', type: 'text', default: 'x' },
        { name: 'due', type: 'date' },
      ]),
    )
    expect(seedDefaults(plan, { name: 'Ada', due: null })).toEqual({ name: 'Ada', due: null })
  })

  it('skips virtual relations — no column, no seed', () => {
    const plan = buildBehaviorPlan(
      descriptor([
        {
          name: 'tags',
          type: 'relation',
          relation: { entity: 'tag', kind: 'many2many', via: 'crm_tag' },
        },
      ]),
    )
    expect(seedDefaults(plan, {})).toEqual({})
  })
})

describe('stripUnstored', () => {
  it('drops store:false fields from the payload and leaves the rest', () => {
    const payload = stripUnstored({ id: '1', name: 'x', margin: 4 }, ['margin'])
    expect(payload).toEqual({ id: '1', name: 'x' })
  })

  it('is the identity when nothing is unstored', () => {
    const draft = { id: '1' }
    expect(stripUnstored(draft, [])).toBe(draft)
  })
})
