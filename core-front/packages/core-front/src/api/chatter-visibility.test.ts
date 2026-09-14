import { describe, expect, it } from 'vitest'
import { effectiveChatterVisible, EMPTY_CHATTER_VISIBILITY } from './chatter-visibility'

describe('effectiveChatterVisible', () => {
  it('is true by design when neither the module nor Settings declares anything', () => {
    expect(effectiveChatterVisible(undefined, EMPTY_CHATTER_VISIBILITY)).toBe(true)
  })

  it("falls back to the module's own default when set", () => {
    expect(effectiveChatterVisible(false, EMPTY_CHATTER_VISIBILITY)).toBe(false)
    expect(effectiveChatterVisible(true, EMPTY_CHATTER_VISIBILITY)).toBe(true)
  })

  it("a non-null Settings override wins over the module's default", () => {
    expect(effectiveChatterVisible(true, { enabled: false })).toBe(false)
    expect(effectiveChatterVisible(false, { enabled: true })).toBe(true)
  })
})
