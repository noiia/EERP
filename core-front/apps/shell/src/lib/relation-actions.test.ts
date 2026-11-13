import { ApiError, unwrapActionResult } from '@eerp/core-front/server'
import { describe, expect, it, vi } from 'vitest'

const apiRequestMock = vi.fn()
const client = {
  list: vi.fn(async () => [{ id: 'r1' }]),
  get: vi.fn(async () => ({ id: 'r1' })),
  create: vi.fn(async () => ({ id: 'r2' })),
  remove: vi.fn(async () => undefined),
  distinctValues: vi.fn(async () => [{ value: 'lead', total: 2 }]),
  listWithTotal: vi.fn(async () => ({ records: [{ id: 'r1' }], total: 7 })),
}
vi.mock('@eerp/core-front/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eerp/core-front/server')>()),
  createServerApiClient: () => client,
  apiRequest: (...a: unknown[]) => apiRequestMock(...a),
}))

import {
  createRelationRecord,
  distinctValues,
  getRecord,
  getViewLayout,
  saveViewLayout,
  listRecords,
  listRecordsPage,
  removeRelationRecord,
} from './relation-actions'

describe('relation actions', () => {
  it('delegate to the server API client', async () => {
    const opts = { pageSize: 5 }
    await expect(listRecords('crm', opts)).resolves.toEqual([{ id: 'r1' }])
    expect(client.list).toHaveBeenCalledWith('crm', opts)
    await expect(listRecordsPage('crm', opts)).resolves.toEqual({ records: [{ id: 'r1' }], total: 7 })
    expect(client.listWithTotal).toHaveBeenCalledWith('crm', opts)
    await expect(getRecord('crm', 'r1')).resolves.toEqual({ id: 'r1' })
    expect(client.get).toHaveBeenCalledWith('crm', 'r1')
    await expect(createRelationRecord('crm', { name: 'x' })).resolves.toEqual({ id: 'r2' })
    expect(client.create).toHaveBeenCalledWith('crm', { name: 'x' })
    await removeRelationRecord('crm', 'r1')
    expect(client.remove).toHaveBeenCalledWith('crm', 'r1')
    await expect(distinctValues('crm', 'status', opts)).resolves.toEqual([
      { value: 'lead', total: 2 },
    ])
    expect(client.distinctValues).toHaveBeenCalledWith('crm', 'status', opts)
  })
})

describe('view layout actions', () => {
  it('GET returns the saved layout, the empty one when the request throws', async () => {
    apiRequestMock.mockResolvedValueOnce({ positions: { a: { x: 1, y: 2 } }, folded: ['b'] })
    await expect(getViewLayout('project_task', 'wbs')).resolves.toEqual({ positions: { a: { x: 1, y: 2 } }, folded: ['b'], notes: [] })
    const notes = [{ id: 'n', text: 'hi', links: ['a'] }]
    apiRequestMock.mockResolvedValueOnce({ positions: {}, folded: [], notes })
    await expect(getViewLayout('project_task', 'pert')).resolves.toEqual({ positions: {}, folded: [], notes })
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/me/view_layout/project_task/wbs')
    apiRequestMock.mockRejectedValueOnce(new Error('boom'))
    await expect(getViewLayout('project_task', 'pert')).resolves.toEqual({ positions: {}, folded: [] })
  })

  it('a failed PUT comes back as an ActionError value, never a silent success', async () => {
    apiRequestMock.mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 }))
    const out = await saveViewLayout('project_task', 'wbs', { positions: {}, folded: [] })
    expect(() => unwrapActionResult(out)).toThrow('nope')
  })

  it('refuses an unknown mode without calling Go', async () => {
    apiRequestMock.mockClear()
    await expect(getViewLayout('project_task', 'x' as 'wbs')).resolves.toEqual({ positions: {}, folded: [] })
    const out = await saveViewLayout('project_task', 'x' as 'wbs', { positions: {}, folded: [] })
    expect(() => unwrapActionResult(out)).toThrow()
    expect(apiRequestMock).not.toHaveBeenCalled()
  })

  it('PUT sends the layout', async () => {
    apiRequestMock.mockResolvedValueOnce(undefined)
    await saveViewLayout('project_task', 'pert', { positions: {}, folded: [] })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/me/view_layout/project_task/pert', { positions: {}, folded: [] })
  })
})
