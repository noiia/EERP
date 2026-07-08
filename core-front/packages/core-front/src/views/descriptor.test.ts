import { describe, expect, it } from 'vitest'
import {
  FIELD_WIDGETS,
  isVirtualRelation,
  resolveWidget,
  validateDescriptorWidgets,
  type FieldDescriptor,
  type FieldType,
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

describe('resolveWidget', () => {
  it('defaults to the first widget of each type', () => {
    expect(resolveWidget(field('text'))).toBe('simple')
    expect(resolveWidget(field('number'))).toBe('float')
    expect(resolveWidget(field('boolean'))).toBe('switch')
    expect(resolveWidget(field('date'))).toBe('simple')
  })

  it('accepts every widget the matrix allows', () => {
    for (const [type, widgets] of Object.entries(FIELD_WIDGETS)) {
      if (type === 'relation') continue // kind-driven — covered below
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
        descriptor([field('text'), field('number', 'stars'), field('boolean', 'switch')]),
      ),
    ).not.toThrow()
  })

  it('throws on the first invalid field', () => {
    expect(() =>
      validateDescriptorWidgets(descriptor([field('text'), field('number', 'long')])),
    ).toThrowError(/widget "long" is not allowed for type "number"/)
  })
})
