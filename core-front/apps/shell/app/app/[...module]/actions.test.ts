import { describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: 'n' })),
  update: vi.fn(async () => ({ id: 'u' })),
  remove: vi.fn(async () => undefined),
  restore: vi.fn(async () => ({ id: 'r' })),
}))
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return { ...actual, createServerApiClient: () => client }
})

import { createRecord, removeRecord, restoreRecord, updateRecord } from './actions'

describe('generic entity Server Actions', () => {
  it('forward to the server ApiClient', async () => {
    expect(await createRecord('crm', { name: 'a' })).toEqual({ id: 'n' })
    expect(await updateRecord('crm', '1', { name: 'b' })).toEqual({ id: 'u' })
    expect(await removeRecord('crm', '1')).toBeUndefined()
    expect(await restoreRecord('crm', '1')).toEqual({ id: 'r' })
    expect(client.create).toHaveBeenCalledWith('crm', { name: 'a' })
    expect(client.update).toHaveBeenCalledWith('crm', '1', { name: 'b' })
    expect(client.remove).toHaveBeenCalledWith('crm', '1')
    expect(client.restore).toHaveBeenCalledWith('crm', '1')
  })
})
