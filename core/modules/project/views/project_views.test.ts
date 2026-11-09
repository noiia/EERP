import { describe, expect, it } from 'vitest'
import mod from './project_views'

describe('project FrontModule', () => {
  it('is named after the module', () => {
    expect(mod.name).toBe('project')
  })
})
