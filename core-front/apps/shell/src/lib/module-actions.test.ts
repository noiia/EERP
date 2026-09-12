import { beforeEach, describe, expect, it, vi } from 'vitest'

const { updateMock, apiRequestMock, revalidateTagMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  apiRequestMock: vi.fn(),
  revalidateTagMock: vi.fn(),
}))

vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return {
    ...actual,
    createServerApiClient: () => ({ update: updateMock }),
    apiRequest: apiRequestMock,
  }
})
vi.mock('next/cache', () => ({ revalidateTag: revalidateTagMock }))

import { getModuleLogs, reloadModule, setModuleActive } from './module-actions'

beforeEach(() => {
  updateMock.mockReset()
  apiRequestMock.mockReset()
  revalidateTagMock.mockReset()
})

describe('setModuleActive', () => {
  it('PUTs { active } to the modules entity and returns the new state — no requires_restart', async () => {
    updateMock.mockResolvedValue({ active: false, name: 'crm' })

    await expect(setModuleActive('crm', false)).resolves.toEqual({ active: false })
    expect(updateMock).toHaveBeenCalledWith('modules', 'crm', { active: false })
  })

  it('propagates a rejected write (e.g. appstore self-deactivation) to the caller', async () => {
    updateMock.mockRejectedValue(new Error('the appstore module cannot deactivate itself.'))
    await expect(setModuleActive('appstore', false)).rejects.toThrow(
      'the appstore module cannot deactivate itself.',
    )
  })
})

describe('reloadModule', () => {
  it('POSTs to /modules/:id/reload and revalidates the modules tag', async () => {
    apiRequestMock.mockResolvedValue({ active: true, name: 'crm' })

    await expect(reloadModule('crm')).resolves.toEqual({ active: true })
    expect(apiRequestMock).toHaveBeenCalledWith('POST', '/modules/crm/reload')
    expect(revalidateTagMock).toHaveBeenCalledWith('modules', 'max')
  })
})

describe('getModuleLogs', () => {
  it('maps the log envelope to camelCase entries', async () => {
    apiRequestMock.mockResolvedValue({
      data: [
        {
          operation_id: 'op-1',
          operation: 'activate',
          source: 'backend',
          level: 'info',
          message: 'activate requested',
          created_at: '2026-07-11T10:00:00Z',
        },
      ],
    })

    await expect(getModuleLogs('crm')).resolves.toEqual([
      {
        operationId: 'op-1',
        operation: 'activate',
        source: 'backend',
        level: 'info',
        message: 'activate requested',
        createdAt: '2026-07-11T10:00:00Z',
      },
    ])
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/modules/crm/logs')
  })
})
