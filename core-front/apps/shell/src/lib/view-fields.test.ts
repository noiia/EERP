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

import { getEntityViewFields, setEntityViewFields } from './view-fields'

beforeEach(() => {
  apiRequestMock.mockReset()
})

describe('getEntityViewFields', () => {
  it('reads and camelCases the entity config from GET /settings/views/:entity/fields', async () => {
    apiRequestMock.mockResolvedValue({ kanban_status_field: 'status', calendar_date_field: null })

    await expect(getEntityViewFields('crm')).resolves.toEqual({
      kanbanStatusField: 'status',
      calendarDateField: null,
    })
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/settings/views/crm/fields')
  })

  it('degrades to the empty config instead of throwing when the read fails', async () => {
    apiRequestMock.mockRejectedValue(new ApiError({ code: 'FORBIDDEN', message: 'x', status: 403 }))
    await expect(getEntityViewFields('crm')).resolves.toEqual({
      kanbanStatusField: null,
      calendarDateField: null,
    })
  })
})

describe('setEntityViewFields', () => {
  it('saves via PUT /settings/views/:entity/fields, snake_casing the body', async () => {
    apiRequestMock.mockResolvedValue(undefined)

    await expect(
      setEntityViewFields('crm', { kanbanStatusField: 'status', calendarDateField: null }),
    ).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/settings/views/crm/fields', {
      kanban_status_field: 'status',
      calendar_date_field: null,
    })
  })

  it('maps a failed save to { ok:false } carrying the envelope message', async () => {
    apiRequestMock.mockRejectedValue(
      new ApiError({ code: 'FORBIDDEN', message: 'Missing permission settings:views:write', status: 403 }),
    )

    await expect(
      setEntityViewFields('crm', { kanbanStatusField: 'status', calendarDateField: null }),
    ).resolves.toEqual({ ok: false, message: 'Missing permission settings:views:write' })
  })

  it('falls back to a generic message on non-ApiError failures', async () => {
    apiRequestMock.mockRejectedValue(new TypeError('fetch failed'))

    await expect(
      setEntityViewFields('crm', { kanbanStatusField: null, calendarDateField: null }),
    ).resolves.toEqual({ ok: false, message: 'Could not save the view field configuration.' })
  })
})
