import { describe, expect, it } from 'vitest'
import type { FieldDescriptor } from './descriptor'
import { summarizeFieldChanges } from './renderers'

const fields: FieldDescriptor[] = [
  { name: 'name', label: 'Name', type: 'text' },
  { name: 'geo_location', label: 'Map position', type: 'geo' },
]
const paris = () => ({ type: 'Point', coordinates: [2.35, 48.85] })

describe('summarizeFieldChanges', () => {
  it('ignores an unchanged geo value (a new but equal object)', () => {
    expect(
      summarizeFieldChanges(
        fields,
        { name: 'A', geo_location: paris() },
        { name: 'A', geo_location: paris() },
      ),
    ).toBeNull()
  })

  it('logs a changed geo value as one readable, translated line', () => {
    const lyon = { type: 'Point', coordinates: [4.83, 45.76] }
    const summary = summarizeFieldChanges(
      fields,
      { name: 'A', geo_location: paris() },
      { name: 'A', geo_location: lyon },
      (s) => (s === 'changed' ? 'modifié' : s),
    )
    expect(summary).toBe('Map position : modifié')
    expect(summary).not.toContain('[object Object]')
  })

  it('logs a geo value set for the first time', () => {
    expect(
      summarizeFieldChanges(
        fields,
        { name: 'A', geo_location: null },
        { name: 'A', geo_location: paris() },
      ),
    ).toBe('Map position : changed')
  })
})
