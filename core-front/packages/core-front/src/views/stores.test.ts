import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewDescriptor } from './descriptor'
import {
  createDashboardStore,
  createEntityStore,
  createFormStore,
  createTreeStore,
  type EntityActions,
} from './stores'
import { useSessionStore } from './session-store'
import { useUiStore } from './ui-store'

interface Contact {
  id: string
  name: string
  parent_id?: string | null
}

const descriptor: ViewDescriptor<Contact> = {
  entity: 'crm',
  viewType: 'form',
  fields: [{ name: 'name', label: 'Name', type: 'text' }],
}

describe('createEntityStore', () => {
  it('seeds records from server initialData and tracks selection', () => {
    const store = createEntityStore(descriptor, [{ id: '1', name: 'A' }])
    expect(store.getState().records).toEqual([{ id: '1', name: 'A' }])
    store.getState().setSelected({ id: '1', name: 'A' })
    expect(store.getState().selected).toEqual({ id: '1', name: 'A' })
  })
})

describe('createFormStore', () => {
  function actions(): EntityActions<Contact> {
    return {
      create: vi.fn(async (body) => ({ id: 'new', name: '', ...body }) as Contact),
      update: vi.fn(async (id, body) => ({ id, name: '', ...body }) as Contact),
    }
  }

  it('routes to create when the draft has no id, then clears dirty', async () => {
    const a = actions()
    const store = createFormStore(descriptor, a, {})
    store.getState().setField('name', 'Ada')
    expect(store.getState().dirty).toBe(true)

    const saved = await store.getState().commit()
    expect(a.create).toHaveBeenCalledWith({ name: 'Ada' })
    expect(a.update).not.toHaveBeenCalled()
    expect(saved).toEqual({ id: 'new', name: 'Ada' })
    expect(store.getState().dirty).toBe(false)
  })

  it('routes to update when the draft has an id', async () => {
    const a = actions()
    const store = createFormStore(descriptor, a, {})
    store.getState().edit({ id: '7', name: 'Grace' })
    store.getState().setField('name', 'Grace H.')

    await store.getState().commit()
    expect(a.update).toHaveBeenCalledWith('7', { id: '7', name: 'Grace H.' })
    expect(a.create).not.toHaveBeenCalled()
    expect(store.getState().dirty).toBe(false)
  })

  it('captures a thrown ApiError instead of clearing dirty', async () => {
    const a: EntityActions<Contact> = {
      create: vi.fn(async () => {
        throw new Error('boom')
      }),
      update: vi.fn(),
    }
    const store = createFormStore(descriptor, a, {})
    store.getState().setField('name', 'X')

    const result = await store.getState().commit()
    expect(result).toBeNull()
    expect(store.getState().error?.code).toBe('INTERNAL_ERROR')
    expect(store.getState().dirty).toBe(true)
  })
})

describe('createTreeStore', () => {
  const tree: ViewDescriptor<Contact> = { ...descriptor, viewType: 'tree' }
  const data: Contact[] = [
    { id: 'root', name: 'Root', parent_id: null },
    { id: 'a', name: 'A', parent_id: 'root' },
    { id: 'b', name: 'B', parent_id: 'root' },
  ]

  it('computes roots and children and toggles expansion', () => {
    const store = createTreeStore(tree, data)
    expect(store.getState().roots().map((r) => r.id)).toEqual(['root'])
    expect(store.getState().children('root').map((r) => r.id)).toEqual(['a', 'b'])

    store.getState().toggle('root')
    expect(store.getState().expanded.has('root')).toBe(true)
    store.getState().toggle('root')
    expect(store.getState().expanded.has('root')).toBe(false)
  })
})

describe('createDashboardStore', () => {
  it('refreshes widgets through the Server Action', async () => {
    const refresh = vi.fn(async () => [{ id: 'w1', title: 'Sales' }])
    const store = createDashboardStore({ ...descriptor, viewType: 'dashboard' }, refresh)
    await store.getState().refresh()
    expect(store.getState().widgets).toEqual([{ id: 'w1', title: 'Sales' }])
  })
})

describe('persisted stores', () => {
  beforeEach(() => {
    localStorage.clear()
    useSessionStore.setState({ identity: null })
    useUiStore.setState({ theme: 'light', sidebarOpen: true, lastRoute: null })
  })

  it('persists the session mirror to localStorage on write', () => {
    const identity = { userId: 'u1', tenantId: 't1', roles: ['admin'], permissions: ['*:*:read'] }
    useSessionStore.getState().setIdentity(identity)

    const persisted = JSON.parse(localStorage.getItem('eerp-session') ?? '{}')
    expect(persisted.state.identity).toEqual(identity)
  })

  it('rehydrates the session mirror from localStorage on load', async () => {
    // Simulate a fresh tab: storage already holds an identity before the store reads it.
    const identity = { userId: 'u2', tenantId: 't1', roles: [], permissions: ['crm:*:read'] }
    localStorage.setItem('eerp-session', JSON.stringify({ state: { identity }, version: 0 }))

    await useSessionStore.persist.rehydrate()
    expect(useSessionStore.getState().identity).toEqual(identity)
  })

  it('round-trips UI prefs through localStorage', () => {
    useUiStore.getState().setTheme('dark')
    useUiStore.getState().setLastRoute('/crm/contacts')

    const persisted = JSON.parse(localStorage.getItem('eerp-ui') ?? '{}')
    expect(persisted.state.theme).toBe('dark')
    expect(persisted.state.lastRoute).toBe('/crm/contacts')
  })
})
