import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  }
})

import { getEntityGraphLayout, setEntityGraphLayout } from './graph-actions'

beforeEach(() => {
  apiRequestMock.mockReset()
})

describe('getEntityGraphLayout', () => {
  it('reads the saved layout from GET /settings/views/:entity/graph', async () => {
    const tiles = [{ id: 't1', x: 0, y: 0, w: 6, h: 6, type: 'stat', config: {} }]
    apiRequestMock.mockResolvedValue({ tiles })

    await expect(getEntityGraphLayout('crm')).resolves.toEqual({ tiles })
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/settings/views/crm/graph')
  })

  it('degrades to an empty canvas instead of throwing when the read fails', async () => {
    apiRequestMock.mockRejectedValue(new ApiError({ code: 'FORBIDDEN', message: 'x', status: 403 }))
    await expect(getEntityGraphLayout('crm')).resolves.toEqual({ tiles: [] })
  })
})

describe('setEntityGraphLayout', () => {
  it('saves via PUT /settings/views/:entity/graph', async () => {
    apiRequestMock.mockResolvedValue(undefined)
    const tiles = [{ id: 't1', x: 0, y: 0, w: 6, h: 6, type: 'stat' as const, config: {} }]

    await expect(setEntityGraphLayout('crm', tiles)).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/settings/views/crm/graph', { tiles })
  })

  it('maps a failed save to { ok:false } carrying the envelope message', async () => {
    apiRequestMock.mockRejectedValue(
      new ApiError({ code: 'FORBIDDEN', message: 'Missing permission settings:views:write', status: 403 }),
    )

    await expect(setEntityGraphLayout('crm', [])).resolves.toEqual({
      ok: false,
      message: 'Missing permission settings:views:write',
    })
  })

  it('falls back to a generic message on non-ApiError failures', async () => {
    apiRequestMock.mockRejectedValue(new TypeError('fetch failed'))

    await expect(setEntityGraphLayout('crm', [])).resolves.toEqual({
      ok: false,
      message: 'Could not save the graph layout.',
    })
  })
})
