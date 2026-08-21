import { describe, expect, it, vi } from 'vitest'
import type { ViewDescriptor } from './descriptor'
import {
  EntityViewServer,
  loadChatterVisibility,
  loadDashboardWidgets,
  loadPictureSize,
  loadView,
  loadViewFields,
} from './loader'
import type { ServerApiClient } from '../api/ApiClient'
import { ApiError } from '../api/errors'
import { EMPTY_VIEW_FIELDS } from '../api/view-fields'
import { EMPTY_CHATTER_VISIBILITY } from '../api/chatter-visibility'

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
    getChatterVisibility: vi.fn(async () => EMPTY_CHATTER_VISIBILITY),
    getPictureSize: vi.fn(async () => null),
    ...overrides,
  } as ServerApiClient
}

const tree: ViewDescriptor<Crm> = { entity: 'crm', viewType: 'tree', fields: [] }
const form: ViewDescriptor<Crm> = { entity: 'crm', viewType: 'form', fields: [] }
const formWithPicture: ViewDescriptor<Crm> = {
  entity: 'crm',
  viewType: 'form',
  fields: [{ name: 'photo', label: 'Photo', type: 'boolean', widget: 'picture' }],
}

describe('loadView', () => {
  it('lists records and the server total for a tree view', async () => {
    const api = fakeApi({
      listWithTotal: vi.fn(async () => ({ records: [{ id: '1', name: 'A' }], total: 1 })) as never,
    })
    const result = await loadView(tree, api)
    expect(api.listWithTotal).toHaveBeenCalledWith('crm', undefined)
    expect(result.initialData).toEqual([{ id: '1', name: 'A' }])
    expect(result.total).toBe(1)
  })

  it('passes listOptions through to the entity list fetch (e.g. a company_id filter)', async () => {
    const api = fakeApi({
      listWithTotal: vi.fn(async () => ({ records: [], total: 0 })) as never,
    })
    await loadView(tree, api, { listOptions: { filter: { company_id: 'co-1' } } })
    expect(api.listWithTotal).toHaveBeenCalledWith('crm', { filter: { company_id: 'co-1' } })
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

describe('loadPictureSize', () => {
  it('prefers the module\'s own override over Base', async () => {
    const api = fakeApi({
      getPictureSize: vi.fn(async (module: string) =>
        module === 'crm' ? { width: 300, height: 300 } : { width: 160, height: 96 },
      ) as never,
    })
    await expect(loadPictureSize('crm', api)).resolves.toEqual({ width: 300, height: 300 })
  })

  it('falls back to Base when the module has no override', async () => {
    const api = fakeApi({
      getPictureSize: vi.fn(async (module: string) =>
        module === 'base' ? { width: 200, height: 150 } : null,
      ) as never,
    })
    await expect(loadPictureSize('crm', api)).resolves.toEqual({ width: 200, height: 150 })
  })

  it('is null when neither the module nor Base has a setting', async () => {
    const api = fakeApi()
    await expect(loadPictureSize('crm', api)).resolves.toBeNull()
  })

  it('degrades to null on an ApiError rather than failing the form', async () => {
    const api = fakeApi({
      getPictureSize: vi.fn(async () => {
        throw new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 })
      }) as never,
    })
    await expect(loadPictureSize('crm', api)).resolves.toBeNull()
  })
})

describe('loadChatterVisibility', () => {
  it("returns the entity's chatter-visibility override", async () => {
    const api = fakeApi({ getChatterVisibility: vi.fn(async () => ({ enabled: false })) as never })
    await expect(loadChatterVisibility('crm', api)).resolves.toEqual({ enabled: false })
  })

  it('degrades to "no override" on an ApiError rather than failing the form', async () => {
    const api = fakeApi({
      getChatterVisibility: vi.fn(async () => {
        throw new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 })
      }) as never,
    })
    await expect(loadChatterVisibility('crm', api)).resolves.toEqual({ enabled: null })
  })
})

describe('EntityViewServer', () => {
  it('resolves chatterVisible from the module default merged with the admin override, for a form', async () => {
    const api = fakeApi({
      get: vi.fn(async () => ({ id: '1' })) as never,
      getChatterVisibility: vi.fn(async () => ({ enabled: null })) as never,
    })
    const element = await EntityViewServer({
      descriptor: { ...form, showChatter: false },
      actions: { create: vi.fn(), update: vi.fn() },
      api,
      recordId: '1',
    })
    expect(element.props.chatterVisible).toBe(false)
  })

  it('the admin override wins over the module default', async () => {
    const api = fakeApi({
      get: vi.fn(async () => ({ id: '1' })) as never,
      getChatterVisibility: vi.fn(async () => ({ enabled: true })) as never,
    })
    const element = await EntityViewServer({
      descriptor: { ...form, showChatter: false },
      actions: { create: vi.fn(), update: vi.fn() },
      api,
      recordId: '1',
    })
    expect(element.props.chatterVisible).toBe(true)
  })

  it('skips chatterVisible entirely for a non-form view', async () => {
    const getChatterVisibility = vi.fn(async () => ({ enabled: false }))
    const api = fakeApi({ getChatterVisibility: getChatterVisibility as never })
    const element = await EntityViewServer({
      descriptor: tree,
      actions: { create: vi.fn(), update: vi.fn() },
      api,
    })
    expect(getChatterVisibility).not.toHaveBeenCalled()
    expect(element.props.chatterVisible).toBeUndefined()
  })

  it('fetches the picture-size cascade for a form with a picture field and a known module', async () => {
    const getPictureSize = vi.fn(async (module: string) =>
      module === 'crm' ? { width: 300, height: 300 } : null,
    )
    const api = fakeApi({ get: vi.fn(async () => ({ id: '1' })) as never, getPictureSize: getPictureSize as never })
    const element = await EntityViewServer({
      descriptor: formWithPicture,
      actions: { create: vi.fn(), update: vi.fn() },
      api,
      recordId: '1',
      module: 'crm',
    })
    expect(getPictureSize).toHaveBeenCalledWith('crm')
    expect(getPictureSize).toHaveBeenCalledWith('base')
    expect(element.props.pictureSize).toEqual({ width: 300, height: 300 })
  })

  it('skips the fetch entirely when no module is given (e.g. Settings -> Users, outside the catch-all)', async () => {
    const getPictureSize = vi.fn(async () => ({ width: 300, height: 300 }))
    const api = fakeApi({ get: vi.fn(async () => ({ id: '1' })) as never, getPictureSize: getPictureSize as never })
    const element = await EntityViewServer({
      descriptor: formWithPicture,
      actions: { create: vi.fn(), update: vi.fn() },
      api,
      recordId: '1',
    })
    expect(getPictureSize).not.toHaveBeenCalled()
    expect(element.props.pictureSize).toBeUndefined()
  })

  it('skips the fetch when the descriptor has no picture-widget field', async () => {
    const getPictureSize = vi.fn(async () => ({ width: 300, height: 300 }))
    const api = fakeApi({ get: vi.fn(async () => ({ id: '1' })) as never, getPictureSize: getPictureSize as never })
    const element = await EntityViewServer({
      descriptor: form,
      actions: { create: vi.fn(), update: vi.fn() },
      api,
      recordId: '1',
      module: 'crm',
    })
    expect(getPictureSize).not.toHaveBeenCalled()
    expect(element.props.pictureSize).toBeUndefined()
  })

  it('skips the fetch for a non-form view even with a module and a picture field declared', async () => {
    const treeWithPicture: ViewDescriptor<Crm> = { ...formWithPicture, viewType: 'tree' }
    const getPictureSize = vi.fn(async () => ({ width: 300, height: 300 }))
    const api = fakeApi({ getPictureSize: getPictureSize as never })
    const element = await EntityViewServer({
      descriptor: treeWithPicture,
      actions: { create: vi.fn(), update: vi.fn() },
      api,
      module: 'crm',
    })
    expect(getPictureSize).not.toHaveBeenCalled()
    expect(element.props.pictureSize).toBeUndefined()
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
