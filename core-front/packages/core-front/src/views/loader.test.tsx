import { describe, expect, it, vi } from 'vitest'
import type { ViewDescriptor } from './descriptor'
import { loadView } from './loader'
import type { ServerApiClient } from '../api/ApiClient'
import { ApiError } from '../api/errors'

interface Crm {
  id: string
  name: string
}

function fakeApi(overrides: Partial<ServerApiClient> = {}): ServerApiClient {
  return {
    list: vi.fn(async () => [] as never),
    get: vi.fn(async () => ({}) as never),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  } as ServerApiClient
}

const tree: ViewDescriptor<Crm> = { entity: 'crm', viewType: 'tree', fields: [] }
const form: ViewDescriptor<Crm> = { entity: 'crm', viewType: 'form', fields: [] }

describe('loadView', () => {
  it('lists records for a tree view', async () => {
    const api = fakeApi({ list: vi.fn(async () => [{ id: '1', name: 'A' }]) as never })
    const result = await loadView(tree, api)
    expect(api.list).toHaveBeenCalledWith('crm')
    expect(result.initialData).toEqual([{ id: '1', name: 'A' }])
  })

  it('loads a single record for a form view with an id', async () => {
    const get = vi.fn(async () => ({ id: '7', name: 'Grace' }))
    const result = await loadView(form, fakeApi({ get: get as never }), { recordId: '7' })
    expect(get).toHaveBeenCalledWith('crm', '7')
    expect(result.initialData).toEqual([{ id: '7', name: 'Grace' }])
  })

  it('seeds empty for a create form (no id / "new")', async () => {
    const api = fakeApi()
    expect((await loadView(form, api, { recordId: 'new' })).initialData).toEqual([])
    expect((await loadView(form, api, {})).initialData).toEqual([])
    expect(api.get).not.toHaveBeenCalled()
  })

  it('folds an ApiError into a serializable error', async () => {
    const api = fakeApi({
      list: vi.fn(async () => {
        throw new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 })
      }) as never,
    })
    const result = await loadView(tree, api)
    expect(result.initialData).toEqual([])
    expect(result.error).toEqual({ code: 'FORBIDDEN', message: 'no', requestId: undefined })
  })
})
