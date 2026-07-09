import { describe, expect, it, vi } from 'vitest'
import type { ViewDescriptor } from './descriptor'
import { loadDashboardWidgets, loadView, loadViewFields } from './loader'
import type { ServerApiClient } from '../api/ApiClient'
import { ApiError } from '../api/errors'
import { EMPTY_VIEW_FIELDS } from '../api/view-fields'

interface Crm {
  id: string
  name: string
}

function fakeApi(overrides: Partial<ServerApiClient> = {}): ServerApiClient {
  return {
    list: vi.fn(async () => [] as never),
    listWithTotal: vi.fn(async () => ({ records: [], total: 0 }) as never),
    get: vi.fn(async () => ({}) as never),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    getViewFields: vi.fn(async () => EMPTY_VIEW_FIELDS),
    ...overrides,
  } as ServerApiClient
}

const tree: ViewDescriptor<Crm> = { entity: 'crm', viewType: 'tree', fields: [] }
const form: ViewDescriptor<Crm> = { entity: 'crm', viewType: 'form', fields: [] }

describe('loadView', () => {
  it('lists records and the server total for a tree view', async () => {
    const api = fakeApi({
      listWithTotal: vi.fn(async () => ({ records: [{ id: '1', name: 'A' }], total: 1 })) as never,
    })
    const result = await loadView(tree, api)
    expect(api.listWithTotal).toHaveBeenCalledWith('crm')
    expect(result.initialData).toEqual([{ id: '1', name: 'A' }])
    expect(result.total).toBe(1)
  })

  it('preserves a total larger than the fetched page (a page_size-truncated read)', async () => {
    const api = fakeApi({
      listWithTotal: vi.fn(async () => ({ records: [{ id: '1', name: 'A' }], total: 500 })) as never,
    })
    const result = await loadView(tree, api)
    expect(result.initialData).toHaveLength(1)
    expect(result.total).toBe(500)
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
      listWithTotal: vi.fn(async () => {
        throw new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 })
      }) as never,
    })
    const result = await loadView(tree, api)
    expect(result.initialData).toEqual([])
    expect(result.error).toEqual({ code: 'FORBIDDEN', message: 'no', requestId: undefined })
  })
})

describe('loadViewFields', () => {
  it('returns the entity Kanban/Calendar field config', async () => {
    const api = fakeApi({
      getViewFields: vi.fn(async () => ({ kanbanStatusField: 'status', calendarDateField: null })) as never,
    })
    await expect(loadViewFields('crm', api)).resolves.toEqual({
      kanbanStatusField: 'status',
      calendarDateField: null,
    })
  })

  it('degrades to the empty config on an ApiError rather than failing the view', async () => {
    const api = fakeApi({
      getViewFields: vi.fn(async () => {
        throw new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 })
      }) as never,
    })
    await expect(loadViewFields('crm', api)).resolves.toEqual(EMPTY_VIEW_FIELDS)
  })
})

describe('loadDashboardWidgets', () => {
  it('builds one block per list view, each carrying its entry count and link', async () => {
    const api = fakeApi({
      list: vi.fn(async (entity: string) =>
        entity === 'crm' ? [{ id: '1' }, { id: '2' }, { id: '3' }] : [{ id: 'a' }],
      ) as never,
    })
    const widgets = await loadDashboardWidgets(
      [
        { entity: 'crm', title: 'Crm', href: '/crm/list' },
        { entity: 'orders', title: 'Orders', href: '/sales/list' },
      ],
      api,
    )
    expect(widgets).toEqual([
      { id: '/crm/list', title: 'Crm', href: '/crm/list', count: 3 },
      { id: '/sales/list', title: 'Orders', href: '/sales/list', count: 1 },
    ])
  })

  it('leaves a block count null when its list view fails to load', async () => {
    const api = fakeApi({
      list: vi.fn(async () => {
        throw new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 })
      }) as never,
    })
    const [widget] = await loadDashboardWidgets([{ entity: 'crm', title: 'Crm', href: '/crm/list' }], api)
    expect(widget).toEqual({ id: '/crm/list', title: 'Crm', href: '/crm/list', count: null })
  })
})
