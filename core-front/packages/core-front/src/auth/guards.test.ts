import { afterEach, describe, expect, it, vi } from 'vitest'

const redirectMock = vi.fn((url: string) => {
  // Next's redirect throws to halt rendering; mirror that so callers stop.
  throw new Error(`NEXT_REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
}))

import { ApiError } from '../api/errors'
import { requirePermission } from './guards'

afterEach(() => {
  redirectMock.mockClear()
})

describe('requirePermission', () => {
  it('passes silently when the permission is granted', () => {
    expect(() => requirePermission(['crm:*:read'], 'crm:contacts:read')).not.toThrow()
    expect(redirectMock).not.toHaveBeenCalled()
  })

  it('throws a FORBIDDEN ApiError when missing and no redirect is configured', () => {
    const err = (() => {
      try {
        requirePermission([], 'crm:contacts:read')
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('FORBIDDEN')
    expect((err as ApiError).status).toBe(403)
  })

  it('redirects when missing and redirectTo is set', () => {
    expect(() => requirePermission([], 'crm:contacts:read', { redirectTo: '/login' })).toThrow(
      /NEXT_REDIRECT:\/login/,
    )
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })
})
