import { beforeAll, describe, expect, it, vi } from 'vitest'

// Live end-to-end App Store Activate/Deactivate against a running backend.
// Skipped unless TEST_API_BASE is set. Drives the exact same path the
// ActivateButton's Server Action takes (docs/roadmaps/app-store.md, Phase 4)
// — PUT /api/v1/modules/:id { active } through the engine's generic
// ApiClient.update() — never the module form's commit, which this form
// never uses (every field is readOnly).
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

interface ModuleRecord {
  id: string
  name: string
  active: boolean
  app_mode?: boolean
}

describe.skipIf(!TEST_API_BASE)('App Store Activate/Deactivate against a live backend', () => {
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

  it('deactivates and reactivates contact, changing only active on disk', async () => {
    const api = createServerApiClient()

    const modules = await api.list<ModuleRecord>('modules')
    expect(Array.isArray(modules)).toBe(true)
    const before = await api.get<ModuleRecord>('modules', 'contact')
    expect(before.active).toBe(true)
    const appModeBefore = before.app_mode

    const deactivated = await api.update<ModuleRecord & { requires_restart: boolean }>('modules', 'contact', {
      active: false,
    })
    expect(deactivated.active).toBe(false)
    expect(deactivated.requires_restart).toBe(true)
    expect(deactivated.app_mode).toBe(appModeBefore)
    expect(revalidateTag).toHaveBeenCalledWith('modules', 'max')

    const persisted = await api.get<ModuleRecord>('modules', 'contact')
    expect(persisted.active).toBe(false)
    expect(persisted.app_mode).toBe(appModeBefore)

    const reactivated = await api.update<ModuleRecord>('modules', 'contact', { active: true })
    expect(reactivated.active).toBe(true)
    expect(reactivated.app_mode).toBe(appModeBefore)
  })
})
