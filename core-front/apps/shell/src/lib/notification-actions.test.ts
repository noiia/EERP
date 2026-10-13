import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return { ...actual, apiRequest: (...a: unknown[]) => apiRequestMock(...a) }
})
const revalidateTag = vi.fn()
vi.mock('next/cache', () => ({ revalidateTag: (...a: unknown[]) => revalidateTag(...a) }))

import { ApiError } from '@eerp/core-front/server'
import { loadNotifications, markNotificationsRead, revalidateSeededEntities } from './notification-actions'

beforeEach(() => {
  apiRequestMock.mockReset()
  revalidateTag.mockReset()
})

describe('notification actions', () => {
  it('loadNotifications maps the feed envelope', async () => {
    apiRequestMock.mockResolvedValue({ data: [{ id: 'n1' }], unread: 3 })
    await expect(loadNotifications()).resolves.toEqual({ items: [{ id: 'n1' }], unread: 3 })
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/notifications')
  })

  it('loadNotifications degrades to null when Go refuses', async () => {
    apiRequestMock.mockRejectedValue(new ApiError({ code: 'UNAUTHENTICATED', message: 'no', status: 401 }))
    await expect(loadNotifications()).resolves.toBeNull()
  })

  it('marks ids, or everything, read', async () => {
    apiRequestMock.mockResolvedValue({ ids: [] })
    await markNotificationsRead(['a', 'b'])
    expect(apiRequestMock).toHaveBeenLastCalledWith('POST', '/notifications/read', { ids: ['a', 'b'] })
    await markNotificationsRead('all')
    expect(apiRequestMock).toHaveBeenLastCalledWith('POST', '/notifications/read', { all: true })
  })

  it('a failed mark-read never throws to the bell', async () => {
    apiRequestMock.mockRejectedValue(new Error('down'))
    await expect(markNotificationsRead('all')).resolves.toBeUndefined()
  })

  it('revalidates only plain entity tags', async () => {
    await revalidateSeededEntities(['contact', 'bad name', 'sale_line'])
    expect(revalidateTag.mock.calls.map((c) => c[0])).toEqual(['contact', 'sale_line'])
  })
})
