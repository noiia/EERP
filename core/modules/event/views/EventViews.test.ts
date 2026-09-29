import { describe, expect, it } from 'vitest'
import mod from './EventViews'

describe('event FrontModule', () => {
  it('registers the expected routes', () => {
    expect(mod.name).toBe('event')
    expect(mod.routes.map((r) => r.path)).toEqual(['/event', '/event/list', '/event/:id'])
  })
})
