import { describe, expect, it } from 'vitest'
import {
  FIELD_WIDGETS,
  resolveWidget,
  validateDescriptorWidgets,
  type FieldDescriptor,
  type FieldType,
  type ViewDescriptor,
} from './descriptor'

const field = (type: FieldType, widget?: string): FieldDescriptor => ({
  name: 'f',
  label: 'F',
  type,
  ...(widget ? { widget } : {}),
})

describe('resolveWidget', () => {
  it('defaults to the first widget of each type', () => {
    expect(resolveWidget(field('text'))).toBe('simple')
    expect(resolveWidget(field('number'))).toBe('float')
    expect(resolveWidget(field('boolean'))).toBe('switch')
    expect(resolveWidget(field('date'))).toBe('simple')
    expect(resolveWidget(field('relation'))).toBe('search')
  })

  it('accepts every widget the matrix allows', () => {
    for (const [type, widgets] of Object.entries(FIELD_WIDGETS)) {
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
      ['relation', 'simple'],
    ]
    for (const [type, widget] of deny) {
      expect(() => resolveWidget(field(type, widget))).toThrowError(
        new RegExp(`"f".*"${widget}".*"${type}"`),
      )
    }
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
