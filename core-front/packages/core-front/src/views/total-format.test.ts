import { describe, expect, it } from 'vitest'
import { formatTotal } from './total-format'

describe('formatTotal', () => {
  it.each([
    [42, undefined, '42'],
    [42, false, '42'],
    [100048, true, '≈ 100048'],
  ])('formatTotal(%s, %s) = %s', (total, estimated, want) => {
    expect(formatTotal(total, estimated)).toBe(want)
  })
})
