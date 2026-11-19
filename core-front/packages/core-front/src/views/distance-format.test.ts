import { describe, expect, it } from 'vitest'
import { formatDistance } from './distance-format'

describe('formatDistance', () => {
  it.each([
    [null, 'metric', '—'],
    [undefined, 'metric', '—'],
    [0, 'metric', '0 m'],
    [742.4, 'metric', '742 m'],
    [12_400, 'metric', '12.4 km'],
    [12_400, 'imperial', '7.7 mi'],
    [50, 'imperial', '164 ft'],
  ] as const)('%s m (%s) → %s', (m, system, want) => {
    expect(formatDistance(m, system, 'en')).toBe(want)
  })
  it('uses the locale decimal separator', () => {
    expect(formatDistance(12_400, 'metric', 'fr')).toBe('12,4 km')
  })
})
