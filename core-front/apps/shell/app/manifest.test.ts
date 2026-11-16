import { describe, expect, it } from 'vitest'
import manifest from './manifest'

describe('manifest', () => {
  it('uses the workspace favicon (company logo fallback) as the app icon', () => {
    const m = manifest()
    expect(m.start_url).toBe('/app')
    expect(m.icons).toEqual([{ src: '/api/v1/public/favicon', sizes: 'any' }])
  })
})
