import { describe, expect, it } from 'vitest'
import type { FieldDescriptor } from '@eerp/core-front'
import { inferKind, kindOfDescriptor } from './field-meta'

const f = (over: Partial<FieldDescriptor>): FieldDescriptor => ({ name: 'x', label: 'X', type: 'text', ...over }) as FieldDescriptor

describe('kindOfDescriptor (a module declares the field)', () => {
  it.each([
    [{ type: 'text', widget: 'phone' }, 'phone'],
    [{ type: 'text', widget: 'long' }, 'multiline'],
    [{ type: 'text', widget: 'html' }, 'multiline'],
    [{ type: 'text', widget: 'url' }, 'url'],
    [{ type: 'text', widget: 'color' }, 'color'],
    [{ type: 'text', name: 'email' }, 'email'],
    [{ type: 'number', widget: 'monetary' }, 'monetary'],
    [{ type: 'number', widget: 'percent' }, 'percent'],
    [{ type: 'number', widget: 'stars' }, 'rating'],
    [{ type: 'number', widget: 'duration' }, 'duration'],
    [{ type: 'number', widget: 'int' }, 'integer'],
    [{ type: 'number', widget: 'float', name: 'unit_price' }, 'monetary'], // the name tells
    [{ type: 'number', widget: 'float', name: 'weight' }, 'decimal'],
    [{ type: 'boolean' }, 'boolean'],
    [{ type: 'date' }, 'date'],
    [{ type: 'date', widget: 'datetime' }, 'datetime'],
    [{ type: 'selection', selection: { options: ['a'] } }, 'selection'],
  ] as [Partial<FieldDescriptor>, string][])('%j → %s', (over, kind) => {
    expect(kindOfDescriptor(f(over)).kind).toBe(kind)
  })

  it('keeps the widget options that change the reading', () => {
    expect(kindOfDescriptor(f({ type: 'number', widget: 'percent', widgetOptions: { base: 'percent', decimals: 1 } })).hints)
      .toEqual({ percentBase: 'percent', decimals: 1 })
  })

  it('points a many2one at its target table and label column', () => {
    expect(kindOfDescriptor(f({ type: 'relation', relation: { entity: 'contact', kind: 'many2one' } })).relation)
      .toEqual({ table: 'contact', labelField: 'name' })
    expect(kindOfDescriptor(f({ type: 'relation', relation: { entity: 'tag', kind: 'many2many' } })).kind).toBe('text')
  })
})

describe('inferKind (no module describes the table)', () => {
  it.each([
    ['active', true, 'boolean'],
    ['qty', 3, 'integer'],
    ['price', 3, 'monetary'],
    ['ratio', 0.5, 'decimal'],
    ['born', '2026-01-02', 'date'],
    ['at', '2026-01-02T10:00:00Z', 'datetime'],
    ['contact', 'a@b.io', 'email'],
    ['site', 'https://x.io', 'url'],
    ['mobile', '0612345678', 'phone'],
    ['notes', 'a\nb', 'multiline'],
    ['name', 'Chair', 'text'],
    ['missing', undefined, 'text'],
  ])('%s = %j → %s', (name, sample, kind) => {
    expect(inferKind(name, sample)).toBe(kind)
  })
})
