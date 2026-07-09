import { describe, expect, it } from 'vitest'
import {
  FIELD_WIDGETS,
  evaluateCondition,
  fieldZeroDefault,
  isVirtualRelation,
  layoutFieldOrder,
  normalizeLayout,
  requiredMissing,
  resolveWidget,
  validateDescriptorWidgets,
  type Condition,
  type FieldDescriptor,
  type FieldType,
  type LayoutNode,
  type RelationDescriptor,
  type ViewDescriptor,
} from './descriptor'

const field = (type: FieldType, widget?: string): FieldDescriptor => ({
  name: 'f',
  label: 'F',
  type,
  ...(widget ? { widget } : {}),
})

const relationField = (
  relation: Partial<RelationDescriptor> & Pick<RelationDescriptor, 'kind'>,
  widget?: string,
): FieldDescriptor => ({
  name: 'f',
  label: 'F',
  type: 'relation',
  relation: { entity: 'contact', ...relation },
  ...(widget ? { widget } : {}),
})

const selectionField = (options: string[], widget?: string): FieldDescriptor => ({
  name: 'f',
  label: 'F',
  type: 'selection',
  selection: { options },
  ...(widget ? { widget } : {}),
})

describe('resolveWidget', () => {
  it('defaults to the first widget of each type', () => {
    expect(resolveWidget(field('text'))).toBe('simple')
    expect(resolveWidget(field('number'))).toBe('float')
    expect(resolveWidget(field('boolean'))).toBe('switch')
    expect(resolveWidget(field('date'))).toBe('simple')
  })

  it('accepts every widget the matrix allows', () => {
    for (const [type, widgets] of Object.entries(FIELD_WIDGETS)) {
      if (type === 'relation' || type === 'selection') continue // block-driven — covered below
      for (const widget of widgets) {
        expect(resolveWidget(field(type as FieldType, widget))).toBe(widget)
      }
    }
  })

  it('rejects widgets the matrix forbids, naming field, type, and widget', () => {
    const deny: Array<[FieldType, string]> = [
      ['text', 'stars'],
      ['number', 'long'],
      ['boolean', 'stars'],
      ['date', 'phone'],
    ]
    for (const [type, widget] of deny) {
      expect(() => resolveWidget(field(type, widget))).toThrowError(
        new RegExp(`"f".*"${widget}".*"${type}"`),
      )
    }
  })
})

describe('resolveWidget — selection', () => {
  it('defaults to select', () => {
    expect(resolveWidget(selectionField(['incoming', 'won']))).toBe('select')
  })

  it('requires a non-empty options list', () => {
    expect(() => resolveWidget(field('selection'))).toThrowError(
      /requires a non-empty selection\.options list/,
    )
    expect(() => resolveWidget(selectionField([]))).toThrowError(
      /requires a non-empty selection\.options list/,
    )
  })

  it('rejects a widget the matrix forbids, naming field, type, and widget', () => {
    expect(() => resolveWidget(selectionField(['incoming', 'won'], 'stars'))).toThrowError(
      /"f".*"stars".*"selection"/,
    )
  })
})

describe('resolveWidget — relations', () => {
  it('derives the widget from the relation kind', () => {
    expect(resolveWidget(relationField({ kind: 'many2one' }))).toBe('search')
    expect(resolveWidget(relationField({ kind: 'one2many', inverseField: 'crm_id' }))).toBe('list')
    expect(resolveWidget(relationField({ kind: 'many2many', via: 'crm_tag' }))).toBe('tags')
  })

  it('requires the relation block on relation fields', () => {
    expect(() => resolveWidget(field('relation'))).toThrowError(/requires a relation block/)
  })

  it('rejects a widget that contradicts the kind', () => {
    expect(() => resolveWidget(relationField({ kind: 'many2one' }, 'tags'))).toThrowError(
      /"tags" does not match relation kind "many2one"/,
    )
  })

  it('requires inverseField on one2many and via on many2many', () => {
    expect(() => resolveWidget(relationField({ kind: 'one2many' }))).toThrowError(
      /one2many relations require inverseField/,
    )
    expect(() => resolveWidget(relationField({ kind: 'many2many' }))).toThrowError(
      /many2many relations require via/,
    )
  })
})

describe('fieldZeroDefault', () => {
  it('returns the natural empty value per type', () => {
    expect(fieldZeroDefault(field('text'))).toBe('')
    expect(fieldZeroDefault(field('number'))).toBe(0)
    expect(fieldZeroDefault(field('boolean'))).toBe(false)
    expect(fieldZeroDefault(field('date'))).toBeNull()
    expect(fieldZeroDefault(relationField({ kind: 'many2one' }))).toBeNull()
  })

  it('a selection field has no "empty" — its zero default is the FIRST option', () => {
    expect(fieldZeroDefault(selectionField(['incoming', 'running', 'won']))).toBe('incoming')
    // Order is what governs it, not alphabetical or anything else.
    expect(fieldZeroDefault(selectionField(['won', 'incoming']))).toBe('won')
  })
})

describe('isVirtualRelation', () => {
  it('marks o2m/m2m virtual, m2o and scalars not', () => {
    expect(isVirtualRelation(relationField({ kind: 'one2many', inverseField: 'x' }))).toBe(true)
    expect(isVirtualRelation(relationField({ kind: 'many2many', via: 'j' }))).toBe(true)
    expect(isVirtualRelation(relationField({ kind: 'many2one' }))).toBe(false)
    expect(isVirtualRelation(field('text'))).toBe(false)
  })
})

describe('validateDescriptorWidgets', () => {
  const descriptor = (fields: FieldDescriptor[]): ViewDescriptor => ({
    entity: 'crm',
    viewType: 'form',
    fields,
  })

  it('passes a descriptor with valid and defaulted widgets', () => {
    expect(() =>
      validateDescriptorWidgets(
        descriptor([
          field('text'),
          field('number', 'stars'),
          field('boolean', 'switch'),
          selectionField(['incoming', 'won']),
        ]),
      ),
    ).not.toThrow()
  })

  it('throws on the first invalid field', () => {
    expect(() =>
      validateDescriptorWidgets(descriptor([field('text'), field('number', 'long')])),
    ).toThrowError(/widget "long" is not allowed for type "number"/)
  })
})

describe('normalizeLayout', () => {
  const three: ViewDescriptor = {
    entity: 'crm',
    viewType: 'form',
    fields: [field('text'), { ...field('text'), name: 'g' }, { ...field('text'), name: 'h' }],
  }

  it('back-compat: no layout ⇒ one implicit, untitled group wrapping fields in declaration order', () => {
    expect(normalizeLayout(three)).toEqual([
      {
        kind: 'group',
        children: [
          { kind: 'field', name: 'f' },
          { kind: 'field', name: 'g' },
          { kind: 'field', name: 'h' },
        ],
      },
    ])
  })

  it('returns an explicit, valid layout as declared', () => {
    const layout: LayoutNode[] = [
      { kind: 'section', title: 'Main', children: [{ kind: 'field', name: 'g' }] },
      { kind: 'row', id: 'r1', children: [{ kind: 'field', name: 'f' }, { kind: 'field', name: 'h' }] },
    ]
    expect(normalizeLayout({ ...three, layout })).toBe(layout)
  })

  it('rejects a layout field name absent from `fields`', () => {
    const layout: LayoutNode[] = [{ kind: 'field', name: 'nope' }]
    expect(() => normalizeLayout({ ...three, layout })).toThrowError(
      /field "nope" is not declared in this view's fields/,
    )
  })

  it('rejects a field appearing twice, even nested in different containers', () => {
    const layout: LayoutNode[] = [
      { kind: 'group', children: [{ kind: 'field', name: 'f' }] },
      { kind: 'row', children: [{ kind: 'field', name: 'f' }] },
    ]
    expect(() => normalizeLayout({ ...three, layout })).toThrowError(
      /field "f" appears more than once/,
    )
  })

  it('rejects a duplicate node id, even across sibling containers', () => {
    const layout: LayoutNode[] = [
      { kind: 'group', id: 'dup', children: [{ kind: 'field', name: 'f' }] },
      { kind: 'row', id: 'dup', children: [{ kind: 'field', name: 'g' }] },
    ]
    expect(() => normalizeLayout({ ...three, layout })).toThrowError(/node id "dup" is not unique/)
  })
})

describe('layoutFieldOrder', () => {
  it('matches fields declaration order for the implicit fallback', () => {
    const three: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [field('text'), { ...field('text'), name: 'g' }, { ...field('text'), name: 'h' }],
    }
    expect(layoutFieldOrder(normalizeLayout(three))).toEqual(['f', 'g', 'h'])
  })

  it('flattens nested group/row/section to leaf tree-walk order', () => {
    const layout: LayoutNode[] = [
      { kind: 'section', title: 'Main', children: [{ kind: 'field', name: 'a' }] },
      {
        kind: 'row',
        children: [
          { kind: 'field', name: 'b' },
          { kind: 'group', children: [{ kind: 'field', name: 'c' }, { kind: 'field', name: 'd' }] },
        ],
      },
    ]
    expect(layoutFieldOrder(layout)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('layout tree — RSC serializability', () => {
  // Descriptors cross the RSC boundary as props: no functions, no undefined,
  // no non-plain values, ever. A JSON round trip is the practical enforcement
  // — anything that doesn't survive it isn't safe to hand to a Server Component.
  it('a layout tree exercising every node kind survives a JSON round trip unchanged', () => {
    const layout: LayoutNode[] = [
      {
        kind: 'section',
        id: 'main',
        title: 'Main',
        children: [
          { kind: 'field', name: 'name' },
          {
            kind: 'row',
            id: 'r1',
            children: [{ kind: 'field', name: 'email' }, { kind: 'field', name: 'phone' }],
          },
        ],
      },
      { kind: 'group', children: [{ kind: 'field', name: 'notes' }] },
    ]
    expect(JSON.parse(JSON.stringify(layout))).toEqual(layout)
  })
})

describe('evaluateCondition', () => {
  const record = { status: 'won', score: 3, tags: null as unknown, note: '' }

  it('eq / ne', () => {
    expect(evaluateCondition({ field: 'status', op: 'eq', value: 'won' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'status', op: 'eq', value: 'lost' }, record)).toBe(false)
    expect(evaluateCondition({ field: 'status', op: 'ne', value: 'lost' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'status', op: 'ne', value: 'won' }, record)).toBe(false)
  })

  it('in', () => {
    expect(
      evaluateCondition({ field: 'status', op: 'in', value: ['won', 'running'] }, record),
    ).toBe(true)
    expect(evaluateCondition({ field: 'status', op: 'in', value: ['lost', 'closed'] }, record)).toBe(
      false,
    )
    // A non-array value is a malformed condition, not a crash — reads as false.
    expect(evaluateCondition({ field: 'status', op: 'in', value: 'won' }, record)).toBe(false)
  })

  it('set / unset: null, undefined, and empty string all count as unset', () => {
    expect(evaluateCondition({ field: 'score', op: 'set' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'score', op: 'unset' }, record)).toBe(false)
    expect(evaluateCondition({ field: 'tags', op: 'unset' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'note', op: 'unset' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'missing', op: 'unset' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'missing', op: 'set' }, record)).toBe(false)
  })

  it('a zero/false value still reads as SET — only null/undefined/"" are unset', () => {
    expect(evaluateCondition({ field: 'zero', op: 'set' }, { zero: 0 })).toBe(true)
    expect(evaluateCondition({ field: 'flag', op: 'set' }, { flag: false })).toBe(true)
  })

  it('all: every sub-condition must hold', () => {
    const cond: Condition = {
      all: [
        { field: 'status', op: 'eq', value: 'won' },
        { field: 'score', op: 'eq', value: 3 },
      ],
    }
    expect(evaluateCondition(cond, record)).toBe(true)
    expect(evaluateCondition(cond, { ...record, score: 1 })).toBe(false)
  })

  it('any: at least one sub-condition must hold', () => {
    const cond: Condition = {
      any: [
        { field: 'status', op: 'eq', value: 'lost' },
        { field: 'status', op: 'eq', value: 'won' },
      ],
    }
    expect(evaluateCondition(cond, record)).toBe(true)
    expect(evaluateCondition(cond, { ...record, status: 'running' })).toBe(false)
  })

  it('combinators nest', () => {
    const cond: Condition = {
      all: [
        { field: 'score', op: 'set' },
        { any: [{ field: 'status', op: 'eq', value: 'won' }, { field: 'status', op: 'eq', value: 'lost' }] },
      ],
    }
    expect(evaluateCondition(cond, record)).toBe(true)
    expect(evaluateCondition(cond, { ...record, status: 'running' })).toBe(false)
  })

  it('a condition on a field that does not exist degrades to false, never throws', () => {
    expect(() => evaluateCondition({ field: 'ghost', op: 'eq', value: 'x' }, record)).not.toThrow()
    expect(evaluateCondition({ field: 'ghost', op: 'eq', value: 'x' }, record)).toBe(false)
  })
})

describe('requiredMissing', () => {
  const descriptor = (fields: FieldDescriptor[]): ViewDescriptor => ({
    entity: 'crm',
    viewType: 'form',
    fields,
  })

  it('static required, unset: reported', () => {
    const d = descriptor([{ name: 'name', type: 'text', required: true }])
    expect(requiredMissing(d, {})).toEqual(['name'])
  })

  it('static required, set: not reported', () => {
    const d = descriptor([{ name: 'name', type: 'text', required: true }])
    expect(requiredMissing(d, { name: 'Ada' })).toEqual([])
  })

  it('a states.required condition acts exactly like static required when it holds', () => {
    const d = descriptor([
      { name: 'status', type: 'text' },
      {
        name: 'comment',
        type: 'text',
        states: { required: { field: 'status', op: 'eq', value: 'lost' } },
      },
    ])
    expect(requiredMissing(d, { status: 'lost' })).toEqual(['comment'])
    expect(requiredMissing(d, { status: 'won' })).toEqual([])
  })

  it('a HIDDEN field never blocks, even if required — visible:false wins', () => {
    const d = descriptor([
      {
        name: 'comment',
        type: 'text',
        required: true,
        states: { visible: { field: 'status', op: 'eq', value: 'lost' } },
      },
    ])
    // status isn't 'lost' -> comment is invisible -> required is inert.
    expect(requiredMissing(d, { status: 'won' })).toEqual([])
    // status IS 'lost' -> comment is visible -> required blocks.
    expect(requiredMissing(d, { status: 'lost' })).toEqual(['comment'])
  })

  it('virtual relations (o2m/m2m) are never reported — they have no column to fill', () => {
    const d = descriptor([
      {
        name: 'tags',
        type: 'relation',
        required: true,
        relation: { entity: 'tag', kind: 'many2many', via: 'crm_tag' },
      },
    ])
    expect(requiredMissing(d, {})).toEqual([])
  })

  it('reports every missing field, in descriptor order', () => {
    const d = descriptor([
      { name: 'a', type: 'text', required: true },
      { name: 'b', type: 'text' },
      { name: 'c', type: 'text', required: true },
    ])
    expect(requiredMissing(d, { b: 'x' })).toEqual(['a', 'c'])
  })
})
