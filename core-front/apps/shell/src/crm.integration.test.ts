import { beforeAll, describe, expect, it, vi } from 'vitest'

// Live end-to-end CRM CRUD against a running backend. Skipped unless TEST_API_BASE is
// set. Logs in against Go to obtain a session (what the BFF does), then drives the same
// engine ApiClient the app uses — list, create, edit, archive (soft delete).
const TEST_API_BASE = process.env.TEST_API_BASE

const cookieJar = new Map<string, string>()
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

interface Contact {
  id: string
  name: string
  email: string
}

describe.skipIf(!TEST_API_BASE)('CRM CRUD against a live backend', () => {
  beforeAll(async () => {
    process.env.API_BASE = TEST_API_BASE as string
    const res = await fetch(`${TEST_API_BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD }),
    })
    if (!res.ok) throw new Error(`login failed: ${res.status}`)
    const data = (await res.json()) as { access_token: string }
    cookieJar.set('eerp_access', data.access_token)
  })

  it('lists, creates, edits, and archives a contact through the engine', async () => {
    const api = createServerApiClient()

    expect(Array.isArray(await api.list<Contact>('crm'))).toBe(true)

    const created = await api.create<Contact>('crm', {
      name: 'IntegrationTest',
      email: `int+${Date.now()}@example.io`,
    })
    expect(created.id).toBeTruthy()
    expect(revalidateTag).toHaveBeenCalledWith('crm', 'max')

    const fetched = await api.get<Contact>('crm', created.id)
    expect(fetched.name).toBe('IntegrationTest')

    const updated = await api.update<Contact>('crm', created.id, {
      name: 'IntegrationTest Edited',
      email: fetched.email,
    })
    expect(updated.name).toBe('IntegrationTest Edited')

    await api.remove('crm', created.id)
    // Soft-deleted: the record is excluded from subsequent reads.
    const status = await api
      .get<Contact>('crm', created.id)
      .catch((e) => (e as { status?: number }).status)
    expect(status).toBe(404)
  })
})
