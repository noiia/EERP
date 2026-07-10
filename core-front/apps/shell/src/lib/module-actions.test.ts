import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return {
    ...actual,
    createServerApiClient: () => ({ update: updateMock }),
  }
})

import { setModuleActive } from './module-actions'

beforeEach(() => {
  updateMock.mockReset()
})

describe('setModuleActive', () => {
  it('PUTs { active } to the modules entity and returns the new state + requiresRestart', async () => {
    updateMock.mockResolvedValue({ active: false, name: 'crm', requires_restart: true })

    await expect(setModuleActive('crm', false)).resolves.toEqual({
      active: false,
      requiresRestart: true,
    })
    expect(updateMock).toHaveBeenCalledWith('modules', 'crm', { active: false })
  })

  it('requiresRestart defaults to false if the response omits it', async () => {
    updateMock.mockResolvedValue({ active: true, name: 'crm' })
    await expect(setModuleActive('crm', true)).resolves.toEqual({
      active: true,
      requiresRestart: false,
    })
  })

  it('propagates a rejected write (e.g. appstore self-deactivation) to the caller', async () => {
    updateMock.mockRejectedValue(new Error('the appstore module cannot deactivate itself.'))
    await expect(setModuleActive('appstore', false)).rejects.toThrow(
      'the appstore module cannot deactivate itself.',
    )
  })
})
