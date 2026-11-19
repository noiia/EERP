import { describe, expect, it } from 'vitest'
import teamsModule from './TeamsViews'

describe('teams views', () => {
  it('registers one /teams route with no permission', () => {
    expect(teamsModule.name).toBe('teams')
    expect(teamsModule.routes.map((r) => r.path)).toEqual(['/teams'])
    expect(teamsModule.routes[0]!.descriptor.permissions).toEqual([])
  })
})
