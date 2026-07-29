import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const createMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return {
    ...actual,
    createServerApiClient: () => ({ create: createMock }),
  }
})

import { seedDemoData } from './dev-seed'
import { seedingAllowed } from './dev-seed-allowed'

function callsFor(entity: string): unknown[][] {
  return createMock.mock.calls.filter(([e]) => e === entity)
}

beforeEach(() => {
  createMock.mockReset()
  let idCounter = 0
  createMock.mockImplementation(async (entity: string, body: Record<string, unknown>) => ({
    id: `${entity}-${(idCounter += 1)}`,
    ...body,
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('seedingAllowed', () => {
  it('falls back to NODE_ENV when ALLOW_DEMO_SEED is unset', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(seedingAllowed()).toBe(false)

    vi.stubEnv('NODE_ENV', 'development')
    expect(seedingAllowed()).toBe(true)
  })

  it('lets ALLOW_DEMO_SEED override a production NODE_ENV, e.g. the standalone Docker image', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ALLOW_DEMO_SEED', 'true')
    expect(seedingAllowed()).toBe(true)
  })

  it('lets ALLOW_DEMO_SEED=false override a non-production NODE_ENV', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('ALLOW_DEMO_SEED', 'false')
    expect(seedingAllowed()).toBe(false)
  })
})

describe('seedDemoData', () => {
  it('refuses to run in production, without touching the API', async () => {
    vi.stubEnv('NODE_ENV', 'production')

    await expect(seedDemoData()).resolves.toEqual({
      ok: false,
      message: 'Demo data seeding is disabled outside development.',
    })
    expect(createMock).not.toHaveBeenCalled()
  })

  it('runs in production when ALLOW_DEMO_SEED=true (the dev-compose Docker override)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ALLOW_DEMO_SEED', 'true')
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const outcome = await seedDemoData()
    expect(outcome.ok).toBe(true)
    expect(createMock).toHaveBeenCalled()
  })

  it('seeds contacts, tags, and CRM records, then links tags via crm_tag junction rows', async () => {
    // Pin Math.random so the whole batch (counts, picks, link counts) is deterministic.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const outcome = await seedDemoData()
    if (!outcome.ok) throw new Error('expected seeding to succeed')

    // contacts and tags are created before crm/crm_tag reference them.
    expect(callsFor('contact')).toHaveLength(10)
    expect(callsFor('tag')).toHaveLength(6)
    expect(callsFor('crm')).toHaveLength(15)

    const [, contactBody] = callsFor('contact')[0] as [string, Record<string, unknown>]
    expect(contactBody).toMatchObject({
      name: expect.any(String),
      email: expect.stringContaining('@'),
      company: expect.any(String),
      status: expect.any(String),
    })

    const [, crmBody] = callsFor('crm')[0] as [string, Record<string, unknown>]
    expect(crmBody).toMatchObject({
      name: expect.any(String),
      email: expect.any(String),
      status: expect.any(String),
      contact_id: expect.stringMatching(/^contact-\d+$/),
      score: expect.any(Number),
    })

    // Every crm_tag link references a real seeded crm + tag id, never a raw index.
    const linkCalls = callsFor('crm_tag')
    expect(linkCalls.length).toBeGreaterThan(0)
    for (const [, body] of linkCalls as [string, Record<string, unknown>][]) {
      expect(body.crm_id).toMatch(/^crm-\d+$/)
      expect(body.tag_id).toMatch(/^tag-\d+$/)
    }

    expect(outcome.results.map((r) => r.entity)).toEqual(['contact', 'tag', 'crm', 'crm_tag'])
    expect(outcome.results.every((r) => r.failed === 0)).toBe(true)
  })

  it('tolerates per-record failures and reports them without aborting the batch', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    createMock.mockImplementation(async (entity: string, body: Record<string, unknown>) => {
      if (entity === 'crm') throw new ApiError({ code: 'FORBIDDEN', message: 'no crm:contacts:write', status: 403 })
      return { id: `${entity}-x`, ...body }
    })

    const outcome = await seedDemoData()
    if (!outcome.ok) throw new Error('expected seeding to succeed')

    const crmResult = outcome.results.find((r) => r.entity === 'crm')
    expect(crmResult).toMatchObject({ created: 0, failed: 15 })
    // Capped at 5 even though all 15 crm creates failed.
    expect(crmResult?.errors).toEqual(Array(5).fill('no crm:contacts:write'))
    // crm never produced an id, so no crm_tag links could reference one.
    expect(outcome.results.some((r) => r.entity === 'crm_tag')).toBe(false)
    // The unrelated entities still fully succeeded.
    expect(outcome.results.find((r) => r.entity === 'contact')).toMatchObject({ created: 10, failed: 0 })
    expect(outcome.results.find((r) => r.entity === 'tag')).toMatchObject({ created: 6, failed: 0 })
  })

  it('caps the reported error messages at 5 even when every record fails', async () => {
    createMock.mockRejectedValue(new Error('boom'))

    const outcome = await seedDemoData()
    if (!outcome.ok) throw new Error('expected seeding to succeed')

    const contactResult = outcome.results.find((r) => r.entity === 'contact')
    expect(contactResult).toMatchObject({ created: 0, failed: 10 })
    expect(contactResult?.errors).toHaveLength(5)
    expect(contactResult?.errors.every((m) => m === 'Unknown error')).toBe(true)
  })
})
