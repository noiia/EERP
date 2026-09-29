import { describe, expect, it } from 'vitest'
import mod from './WebsiteViews'

describe('website FrontModule', () => {
  it('registers the expected routes', () => {
    expect(mod.name).toBe('website')
    expect(mod.routes.map((r) => r.path)).toEqual(['/website', '/website/list', '/website/:id'])
  })
})
