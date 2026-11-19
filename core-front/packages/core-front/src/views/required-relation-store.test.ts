import { beforeEach, describe, expect, it } from 'vitest'
import { useHasLinksStore } from './required-relation-store'

describe('useHasLinksStore', () => {
  beforeEach(() => useHasLinksStore.setState({ hasLinks: {} }))

  it('starts empty', () => {
    expect(useHasLinksStore.getState().hasLinks).toEqual({})
  })

  it('records a field\'s reported state, keyed by field name', () => {
    useHasLinksStore.getState().setHasLinks('current_tenant', false)
    expect(useHasLinksStore.getState().hasLinks).toEqual({ current_tenant: false })
    useHasLinksStore.getState().setHasLinks('current_tenant', true)
    expect(useHasLinksStore.getState().hasLinks).toEqual({ current_tenant: true })
  })

  it('setting the same value again is a no-op (no new object identity)', () => {
    useHasLinksStore.getState().setHasLinks('current_tenant', true)
    const before = useHasLinksStore.getState().hasLinks
    useHasLinksStore.getState().setHasLinks('current_tenant', true)
    expect(useHasLinksStore.getState().hasLinks).toBe(before)
  })
})
