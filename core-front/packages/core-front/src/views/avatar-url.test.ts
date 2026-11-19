import { describe, expect, it } from 'vitest'
import { avatarUrl } from './avatar-url'

describe('avatarUrl', () => {
  it('points at the BFF only when the user has an avatar', () => {
    expect(avatarUrl('u 1', true)).toBe('/api/avatars/u%201')
    expect(avatarUrl('u1', false)).toBeUndefined()
    expect(avatarUrl('u1')).toBeUndefined()
  })
})
