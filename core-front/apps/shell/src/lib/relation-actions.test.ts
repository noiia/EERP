import { describe, expect, it, vi } from 'vitest'

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
}))

import {
  createRelationRecord,
  distinctValues,
  getRecord,
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
