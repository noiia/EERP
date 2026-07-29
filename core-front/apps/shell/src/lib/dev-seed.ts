'use server'
import { ApiError, createServerApiClient } from '@eerp/core-front/server'
import { seedingAllowed } from './dev-seed-allowed'

// Settings -> Developer: populates the workspace with realistic-looking demo
// records through the SAME generic entity API (POST /{entity}) any other write
// in the app goes through — no dedicated backend route, Go authorizes each
// create() call from the caller's own session exactly like a real user's write.
// Never runs outside development (the seedingAllowed() guard below): this is a
// bulk, irreversible write and must never land in a real tenant. Only a UI
// affordance exists to trigger this — no cron/API surface, so an admin has to
// be signed in and on the Developer settings page to run it.

export interface SeedEntityResult {
  entity: string
  created: number
  failed: number
  errors: string[]
}

export type SeedResult = { ok: true; results: SeedEntityResult[] } | { ok: false; message: string }

const FIRST_NAMES = [
  'Ava', 'Liam', 'Maya', 'Noah', 'Elena', 'Lucas', 'Sofia', 'Mateo',
  'Nina', 'Kenji', 'Zoe', 'Omar', 'Ines', 'Theo', 'Amara', 'Felix',
] as const
const LAST_NAMES = [
  'Bennett', 'Nguyen', 'Kowalski', 'Okafor', 'Rossi', 'Dubois', 'Larsen', 'Haddad',
  'Petrova', 'Silva', 'Andersen', 'Moreau', 'Kimura', 'Novak', 'Adeyemi', 'Costa',
] as const
const COMPANIES = [
  'Northwind Logistics', 'Bluepeak Robotics', 'Cedarline Foods', 'Vantage Analytics',
  'Solara Energy', 'Ironhall Manufacturing', 'Driftwood Studio', 'Meridian Health',
  'Quillfeather Media', 'Basalt Construction', 'Fernbridge Capital', 'Amberwood Retail',
] as const
const CRM_STATUSES = ['incoming', 'running', 'won', 'lost', 'closed'] as const
const CRM_STATUS_SCORE: Record<(typeof CRM_STATUSES)[number], number> = {
  incoming: 1,
  running: 2,
  won: 3,
  lost: 0,
  closed: 0,
}
const CRM_NOTES = [
  'Introduced via the autumn trade show.',
  'Wants a pilot before committing to the full package.',
  'Existing customer looking to expand seats.',
  'Referred by an existing account.',
  'Following up after a stalled quarter.',
  'Comparing us against two other vendors.',
] as const
const TAG_NAMES = ['VIP', 'Newsletter', 'Hot lead', 'Enterprise', 'Churn risk', 'Partner'] as const

const CONTACT_COUNT = 10
const CRM_COUNT = 15
const TAG_LINKS_MAX_PER_CRM = 2

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Deterministic-enough fake email: firstname.lastname@company-slug.example. */
function fakeEmail(first: string, last: string, company: string): string {
  return `${first.toLowerCase()}.${last.toLowerCase()}@${slugify(company)}.example`
}

function buildContacts(): Record<string, unknown>[] {
  return Array.from({ length: CONTACT_COUNT }, () => {
    const first = pick(FIRST_NAMES)
    const last = pick(LAST_NAMES)
    const company = pick(COMPANIES)
    return {
      name: `${first} ${last}`,
      email: fakeEmail(first, last, company),
      company,
      status: pick(['prospect', 'customer', 'archived']),
    }
  })
}

function buildCrmRecords(contacts: { id: string }[]): Record<string, unknown>[] {
  return Array.from({ length: CRM_COUNT }, () => {
    const first = pick(FIRST_NAMES)
    const last = pick(LAST_NAMES)
    const company = pick(COMPANIES)
    const status = pick(CRM_STATUSES)
    // A third of the batch has no linked contact — plenty of real workspaces
    // start a deal before a contact record exists for it.
    const contact = contacts.length > 0 && Math.random() > 0.33 ? pick(contacts) : null
    return {
      name: `${first} ${last}`,
      email: fakeEmail(first, last, company),
      company,
      status,
      contact_id: contact?.id ?? null,
      phone: `+1${String(2000000000 + Math.floor(Math.random() * 999999999)).padStart(10, '0')}`,
      notes: pick(CRM_NOTES),
      satisfaction: Math.round(Math.random() * 100) / 100,
      deals: Math.floor(Math.random() * 5),
      score: CRM_STATUS_SCORE[status],
    }
  })
}

function buildTagLinks(
  crmRecords: { id: string }[],
  tags: { id: string }[],
): Record<string, unknown>[] {
  if (tags.length === 0) return []
  const links: Record<string, unknown>[] = []
  for (const crm of crmRecords) {
    const linkCount = Math.floor(Math.random() * (TAG_LINKS_MAX_PER_CRM + 1))
    const chosen = new Set<string>()
    for (let i = 0; i < linkCount; i += 1) {
      const tag = pick(tags)
      if (chosen.has(tag.id)) continue
      chosen.add(tag.id)
      links.push({ crm_id: crm.id, tag_id: tag.id })
    }
  }
  return links
}

/** Creates every body, tolerating per-record failures (e.g. a missing permission). */
async function createMany<R extends { id: string }>(
  entity: string,
  bodies: Record<string, unknown>[],
): Promise<{ result: SeedEntityResult; records: R[] }> {
  const client = createServerApiClient()
  const records: R[] = []
  const result: SeedEntityResult = { entity, created: 0, failed: 0, errors: [] }
  for (const body of bodies) {
    try {
      records.push(await client.create<R>(entity, body))
      result.created += 1
    } catch (e) {
      result.failed += 1
      if (result.errors.length < 5) {
        result.errors.push(e instanceof ApiError ? e.message : 'Unknown error')
      }
    }
  }
  return { result, records }
}

/**
 * Seed the workspace with fake contacts, CRM opportunities, tags, and the
 * junction rows linking them — through the ordinary entity API, in dependency
 * order (contacts and tags before the CRM/crm_tag rows that reference them).
 */
export async function seedDemoData(): Promise<SeedResult> {
  if (!seedingAllowed()) {
    return { ok: false, message: 'Demo data seeding is disabled outside development.' }
  }

  const results: SeedEntityResult[] = []

  const contactsOutcome = await createMany<{ id: string }>('contact', buildContacts())
  results.push(contactsOutcome.result)

  const tagsOutcome = await createMany<{ id: string }>(
    'tag',
    TAG_NAMES.map((name) => ({ name })),
  )
  results.push(tagsOutcome.result)

  const crmOutcome = await createMany<{ id: string }>('crm', buildCrmRecords(contactsOutcome.records))
  results.push(crmOutcome.result)

  const tagLinks = buildTagLinks(crmOutcome.records, tagsOutcome.records)
  if (tagLinks.length > 0) {
    const linksOutcome = await createMany('crm_tag', tagLinks)
    results.push(linksOutcome.result)
  }

  return { ok: true, results }
}
