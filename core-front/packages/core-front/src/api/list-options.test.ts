import { describe, expect, it } from 'vitest'
import { mergeListOptions } from './list-options'

describe('mergeListOptions', () => {
  it('merges each condition map key by key, the extra layer winning', () => {
    expect(
      mergeListOptions(
        { filter: { type: 'surface' }, empty: ['a'] },
        { filter: { name: 'x' }, gte: { d: '2026-01-01' }, empty: ['a', 'b'], pageSize: 5 },
      ),
    ).toEqual({
      filter: { type: 'surface', name: 'x' },
      gte: { d: '2026-01-01' },
      empty: ['a', 'b'],
      pageSize: 5,
    })
  })

  it('returns whichever side exists when the other is undefined', () => {
    const only = { filter: { a: '1' } }
    expect(mergeListOptions(undefined, only)).toBe(only)
    expect(mergeListOptions(only, undefined)).toBe(only)
  })
})
