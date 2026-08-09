import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequestMock = vi.fn()
const createMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
    createServerApiClient: () => ({ create: createMock }),
  }
})

import { createCompanyAndActivate } from './company'

beforeEach(() => {
  apiRequestMock.mockReset()
  createMock.mockReset()
})

describe('createCompanyAndActivate', () => {
  it('creates the company, clones settings from the prior active company, then switches to the new one', async () => {
    apiRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/me/preferences') {
        return { active_company: { id: 'old-co', name: 'Old Co' } }
      }
      return undefined
    })
    createMock.mockResolvedValue({ id: 'new-co', name: 'New Co' })

    const result = await createCompanyAndActivate({ name: 'New Co' })

    expect(result).toEqual({ id: 'new-co', name: 'New Co' })
    expect(createMock).toHaveBeenCalledWith('company', { name: 'New Co' })
    expect(apiRequestMock).toHaveBeenCalledWith('POST', '/company/old-co/clone-settings', {
      target_company_id: 'new-co',
    })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/me/preferences', { active_company_id: 'new-co' })

    // Order: read preferences, create, clone (from the OLD company, before switching), then switch.
    const calls = apiRequestMock.mock.calls.map((c) => `${c[0]} ${c[1]}`)
    expect(calls).toEqual(['GET /me/preferences', 'POST /company/old-co/clone-settings', 'PUT /me/preferences'])
  })

  it('skips cloning (but still switches) when no prior active company is known', async () => {
    apiRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/me/preferences') return { active_company: null }
      return undefined
    })
    createMock.mockResolvedValue({ id: 'new-co', name: 'New Co' })

    await createCompanyAndActivate({ name: 'New Co' })

    expect(apiRequestMock).not.toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/clone-settings'),
      expect.anything(),
    )
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/me/preferences', { active_company_id: 'new-co' })
  })
})
