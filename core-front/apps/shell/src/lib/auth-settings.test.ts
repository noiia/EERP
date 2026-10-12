import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return { ...actual, apiRequest: (...a: unknown[]) => apiRequestMock(...a) }
})

import { ApiError } from '@eerp/core-front/server'
import { getAuthSettings, listRoles, saveAuthSettings, testAuthMethod } from './auth-settings'

const goError = () => Promise.reject(new ApiError({ code: 'BAD', message: 'nope', status: 400 }))

beforeEach(() => {
  apiRequestMock.mockReset()
})

describe('auth-settings actions', () => {
  it('getAuthSettings fills absent lists so the form never reads undefined', async () => {
    apiRequestMock.mockResolvedValue({ default: 'ldap', erp_url: 'https://erp', callback_url: 'cb' })
    await expect(getAuthSettings()).resolves.toEqual({
      ok: true,
      settings: {
        default: 'ldap',
        enabled: [],
        ldap: null,
        oidc: [],
        role_mapping: [],
        erp_url: 'https://erp',
        callback_url: 'cb',
      },
    })
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/settings/auth')
  })

  it('a failed load is reported, never an empty config (saving it would wipe the stored one)', async () => {
    apiRequestMock.mockImplementation(goError)
    await expect(getAuthSettings()).resolves.toEqual({ ok: false, message: 'nope' })
    apiRequestMock.mockImplementation(() => Promise.reject(new Error('boom')))
    await expect(getAuthSettings()).resolves.toEqual({ ok: false, message: '' })
  })

  it('saveAuthSettings PUTs the config and returns Go\'s message on a rejection', async () => {
    const input = { default: 'local', enabled: [], ldap: null, oidc: [], role_mapping: [], erp_url: '' }
    apiRequestMock.mockResolvedValue(undefined)
    await expect(saveAuthSettings(input)).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/settings/auth', input)

    apiRequestMock.mockImplementation(goError)
    await expect(saveAuthSettings(input)).resolves.toEqual({ ok: false, message: 'nope' })
  })

  it('testAuthMethod relays Go\'s verdict, or the error message', async () => {
    apiRequestMock.mockResolvedValue({ ok: true, message: 'bound' })
    await expect(testAuthMethod('ldap')).resolves.toEqual({ ok: true, message: 'bound' })
    expect(apiRequestMock).toHaveBeenCalledWith('POST', '/settings/auth/test', { method: 'ldap' })

    apiRequestMock.mockImplementation(() => Promise.reject(new Error('boom')))
    await expect(testAuthMethod('oidc:google')).resolves.toEqual({ ok: false, message: '' })
  })

  it('listRoles accepts the list envelope or a bare array, and degrades to none', async () => {
    const roles = [{ id: 'r1', name: 'Admin' }]
    apiRequestMock.mockResolvedValue({ data: roles })
    await expect(listRoles()).resolves.toEqual(roles)
    apiRequestMock.mockResolvedValue(roles)
    await expect(listRoles()).resolves.toEqual(roles)
    apiRequestMock.mockResolvedValue({})
    await expect(listRoles()).resolves.toEqual([])
    apiRequestMock.mockImplementation(goError)
    await expect(listRoles()).resolves.toEqual([])
  })
})
