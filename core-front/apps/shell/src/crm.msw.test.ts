import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

// MSW twin of the CRM CRUD integration test: replays the same flow in CI without a
// backend, against handlers emitting Go's real shapes — paginated { data } list,
// BuildResponse single objects, 204 delete, flat { error, code } envelope. Proves the
// engine ApiClient speaks the actual data-API contract end to end.

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

import { ApiError, createServerApiClient } from '@eerp/core-front/server'

interface Contact {
  id: string
  name: string
  email: string
  company?: string
  status?: string
}

const BASE = 'http://backend.test'
const server = setupServer()

let contacts: Contact[]
let seq: number

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
afterEach(() => server.resetHandlers())

beforeEach(() => {
  process.env.API_BASE = BASE
  delete process.env.API_VERSION
  revalidateTag.mockClear()
  contacts = []
  seq = 0

  server.use(
    http.get(`${BASE}/api/v1/crm`, () =>
      HttpResponse.json({ data: contacts, total: contacts.length, page: 1, page_size: 50 }),
    ),
    http.post(`${BASE}/api/v1/crm`, async ({ request }) => {
      const body = (await request.json()) as Partial<Contact>
      const record = { id: `c${++seq}`, name: '', email: '', ...body } as Contact
      contacts.push(record)
      return HttpResponse.json(record, { status: 201 })
    }),
    http.get(`${BASE}/api/v1/crm/:id`, ({ params }) => {
      const record = contacts.find((c) => c.id === params.id)
      return record
        ? HttpResponse.json(record)
        : HttpResponse.json({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 })
    }),
    http.put(`${BASE}/api/v1/crm/:id`, async ({ params, request }) => {
      const body = (await request.json()) as Partial<Contact>
      const i = contacts.findIndex((c) => c.id === params.id)
      contacts[i] = { ...contacts[i], ...body }
      return HttpResponse.json(contacts[i])
    }),
    http.delete(`${BASE}/api/v1/crm/:id`, ({ params }) => {
      contacts = contacts.filter((c) => c.id !== params.id)
      return new HttpResponse(null, { status: 204 })
    }),
  )
})

describe('CRM CRUD via the engine ApiClient (MSW twin)', () => {
  it('lists (unwrapping {data}), creates, gets, updates, and archives', async () => {
    const api = createServerApiClient()

    expect(await api.list<Contact>('crm')).toEqual([])

    const created = await api.create<Contact>('crm', { name: 'Ada', email: 'ada@x.io' })
    expect(created).toMatchObject({ id: 'c1', name: 'Ada', email: 'ada@x.io' })
    expect(revalidateTag).toHaveBeenCalledWith('crm', 'max')

    const list = await api.list<Contact>('crm')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'c1' })

    const fetched = await api.get<Contact>('crm', 'c1')
    expect(fetched).toMatchObject({ name: 'Ada' })

    revalidateTag.mockClear()
    const updated = await api.update<Contact>('crm', 'c1', { name: 'Ada L.', email: 'ada@x.io' })
    expect(updated).toMatchObject({ name: 'Ada L.' })
    expect(revalidateTag).toHaveBeenCalledWith('crm', 'max')

    revalidateTag.mockClear()
    await api.remove('crm', 'c1')
    expect(revalidateTag).toHaveBeenCalledWith('crm', 'max')
    expect(await api.list<Contact>('crm')).toEqual([])
  })

  it('surfaces a 404 as an ApiError', async () => {
    const err = (await createServerApiClient()
      .get('crm', 'missing')
      .catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.status).toBe(404)
  })
})
