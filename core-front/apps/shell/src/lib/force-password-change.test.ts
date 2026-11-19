import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return { ...actual, apiRequest: (...args: unknown[]) => apiRequestMock(...args) }
})

import { changeMyPassword, getMyUserProfile, type SelfUserProfile } from './force-password-change'

const profile: SelfUserProfile = {
  id: 'u1',
  email: 'old@x.test',
  username: null,
  name: 'A',
  surname: 'B',
  display_name: 'AB',
  job_title: '',
  phone: '',
  address_number: null,
  address_complement: '',
  address_street: '',
  address_zip_code: '',
  address_city: '',
  address_state: '',
  address_country: '',
}

beforeEach(() => {
  apiRequestMock.mockReset()
})

describe('getMyUserProfile', () => {
  it('reads GET /users/:id, and degrades to null on failure', async () => {
    apiRequestMock.mockResolvedValueOnce(profile)
    await expect(getMyUserProfile('u1')).resolves.toEqual(profile)
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/users/u1')
    apiRequestMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(getMyUserProfile('u1')).resolves.toBeNull()
  })
})

describe('changeMyPassword', () => {
  it('re-sends the whole profile with the new password, keeping the email when none is given', async () => {
    apiRequestMock.mockResolvedValue(undefined)
    await expect(changeMyPassword(profile, 'longenough1', '  ')).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith(
      'PUT',
      '/users/u1',
      expect.objectContaining({ email: 'old@x.test', password: 'longenough1', name: 'A' }),
    )
  })

  it('uses a new, trimmed email when given', async () => {
    apiRequestMock.mockResolvedValue(undefined)
    await changeMyPassword(profile, 'longenough1', ' new@x.test ')
    expect(apiRequestMock).toHaveBeenCalledWith(
      'PUT',
      '/users/u1',
      expect.objectContaining({ email: 'new@x.test' }),
    )
  })

  it.each([
    [
      'the Go envelope message',
      new ApiError({ code: 'VALIDATION_ERROR', message: 'Email taken', status: 422 }),
      'Email taken',
    ],
    [
      'a generic message on other failures',
      new TypeError('fetch failed'),
      'Could not change your password.',
    ],
  ])('reports %s', async (_, err, message) => {
    apiRequestMock.mockRejectedValue(err)
    await expect(changeMyPassword(profile, 'longenough1', '')).resolves.toEqual({
      ok: false,
      message,
    })
  })
})
