import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

// MSW twin of the App Store Activate/Deactivate integration test: replays
// the same flow in CI without a backend, against handlers emitting Go's
// real shapes for the /api/v1/modules surface — {data, total} list envelope
// (Handler.List), a bare record on GET/:id (Handler.Get), and PUT/:id
// echoing the patched record plus requires_restart: true (Handler.Update,
// docs/roadmaps/app-store.md decision #5).

const cookieJar = new Map([['eerp_access', 'test-token']])
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set: () => {},
    delete: () => {},
  }),
}))

const revalidateTag = vi.fn()
vi.mock('next/cache', () => ({ revalidateTag: (tag: string, profile: unknown) => revalidateTag(tag, profile) }))

import { createServerApiClient } from '@eerp/core-front/server'

interface ModuleRecord {
  id: string
  name: string
  active: boolean
  app_mode?: boolean
}

const BASE = 'http://backend.test'
const server = setupServer()

let modules: ModuleRecord[]

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
afterEach(() => server.resetHandlers())

beforeEach(() => {
  process.env.API_BASE = BASE
  delete process.env.API_VERSION
  revalidateTag.mockClear()
  modules = [
    { id: 'contact', name: 'contact', active: true, app_mode: true },
    { id: 'appstore', name: 'appstore', active: true, app_mode: true },
  ]

  server.use(
    http.get(`${BASE}/api/v1/modules`, () =>
      HttpResponse.json({ data: modules, total: modules.length }),
    ),
    http.get(`${BASE}/api/v1/modules/:id`, ({ params }) => {
      const record = modules.find((m) => m.id === params.id)
      return record
        ? HttpResponse.json(record)
        : HttpResponse.json(
            { error: { code: 'NOT_FOUND', message: 'No such module.', request_id: 'r1' } },
            { status: 404 },
          )
    }),
    http.put(`${BASE}/api/v1/modules/:id`, async ({ params, request }) => {
      const body = (await request.json()) as { active?: unknown }
      if (typeof body.active !== 'boolean') {
        return HttpResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: '"active" must be a boolean.', request_id: 'r2' } },
          { status: 400 },
        )
      }
      if (params.id === 'appstore' && body.active === false) {
        return HttpResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'the appstore module cannot deactivate itself.',
              request_id: 'r3',
            },
          },
          { status: 400 },
        )
      }
      const i = modules.findIndex((m) => m.id === params.id)
      modules[i] = { ...modules[i], active: body.active }
      return HttpResponse.json({ ...modules[i], requires_restart: true })
    }),
  )
})

describe('App Store Activate/Deactivate via the engine ApiClient (MSW twin)', () => {
  it('deactivates and reactivates contact, changing only active', async () => {
    const api = createServerApiClient()

    const list = await api.list<ModuleRecord>('modules')
    expect(list).toHaveLength(2)

    const before = await api.get<ModuleRecord>('modules', 'contact')
    expect(before.active).toBe(true)

    const deactivated = await api.update<ModuleRecord & { requires_restart: boolean }>('modules', 'contact', {
      active: false,
    })
    expect(deactivated).toMatchObject({ active: false, app_mode: true, requires_restart: true })
    expect(revalidateTag).toHaveBeenCalledWith('modules', 'max')

    const persisted = await api.get<ModuleRecord>('modules', 'contact')
    expect(persisted.active).toBe(false)
    expect(persisted.app_mode).toBe(true)

    const reactivated = await api.update<ModuleRecord>('modules', 'contact', { active: true })
    expect(reactivated.active).toBe(true)
  })

  it('rejects the appstore module deactivating itself as a VALIDATION_ERROR', async () => {
    const api = createServerApiClient()
    const err = (await api.update('modules', 'appstore', { active: false }).catch((e) => e)) as {
      code?: string
      message?: string
    }
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toBe('the appstore module cannot deactivate itself.')
  })
})
