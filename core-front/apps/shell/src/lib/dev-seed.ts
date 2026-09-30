'use server'
import { deflateSync, crc32 } from 'node:zlib'
import { ApiError, apiRequest, createServerApiClient, uploadPicture } from '@eerp/core-front/server'
import { revalidateTag } from 'next/cache'
import { seedingAllowed } from './dev-seed-allowed'
import { getMyLocalePreferences } from './preferences'
import { PAPER_SIZE_PRESETS } from '../../app/app/settings/appearance/page-formats/descriptors'

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

/** "light" = the handful of records below, through the generic entity API;
 * "full" = ~100 000 rows per business table, written by Go with set-based SQL
 * (POST /dev_seed — core/internal/devseed), plus Graph views and calculated
 * fields on every list view that ends up over 10 000 rows. */
export type SeedVolume = 'light' | 'full'

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

// warehouse.Product's small fixed catalog — a product catalog reads more
// realistically as concrete offerings than as randomly combined words, unlike
// contacts/CRM records above. tax_rate is a 0..1 ratio (see warehouse/module.go).
const PRODUCTS = [
  {
    name: 'Standard consulting hour', reference: 'CONS-STD', unit: 'hour', unit_price: 85, tax_rate: 0.2,
    description: 'An hour of senior consulting, remote or on site, billed in quarter hours.',
    variants: [{ name: 'Standard consulting hour — On site', unit_price: 110 }, { name: 'Standard consulting hour — Weekend', unit_price: 130 }],
    color: [37, 99, 235],
  },
  {
    name: 'Onboarding package', reference: 'ONB-PKG', unit: 'pcs', unit_price: 1200, tax_rate: 0.2,
    description: 'Kick-off workshop, data import and two weeks of guided start for your team.',
    variants: [{ name: 'Onboarding package — Team (up to 20)', unit_price: 1900 }],
    color: [22, 163, 74],
  },
  {
    name: 'Support retainer (monthly)', reference: 'SUP-MO', unit: 'month', unit_price: 400, tax_rate: 0.2,
    description: 'Business-hours support with a next-day answer on every ticket.',
    variants: [{ name: 'Support retainer — Premium 24/7', unit_price: 900 }, { name: 'Support retainer — Annual', unit_price: 4200 }],
    color: [217, 119, 6],
  },
  {
    name: 'Server rack unit', reference: 'HW-RACK', unit: 'pcs', unit_price: 650, tax_rate: 0.055,
    description: '1U rack server, 32 GB RAM, dual power supply, three-year warranty.',
    variants: [{ name: 'Server rack unit — 2U, 64 GB', unit_price: 1150 }, { name: 'Server rack unit — Refurbished', unit_price: 420 }],
    color: [100, 116, 139],
  },
  {
    name: 'Training workshop (half day)', reference: 'TRN-HD', unit: 'pcs', unit_price: 300, tax_rate: 0.2,
    description: 'A hands-on half day for up to 8 people, slides and exercises included.',
    variants: [{ name: 'Training workshop — Full day', unit_price: 550 }],
    color: [219, 39, 119],
  },
  {
    name: 'Custom integration', reference: 'DEV-INT', unit: 'pcs', unit_price: 2400, tax_rate: 0.2,
    description: 'A connector between EERP and one of your tools, specified, built and documented.',
    variants: [{ name: 'Custom integration — With maintenance', unit_price: 3100 }],
    color: [124, 58, 237],
  },
] as const

const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'] as const
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const

// The seller's own letterhead — fixed rather than randomized per document,
// since every invoice/quote from one workspace is issued by the same
// company. sale.Invoice/Quote's issuer_*/payment_*/legal_notice columns are
// plain (non-pointer) strings — NOT NULL with no default — so Create 422s
// with VALIDATION_ERROR unless every one of them is present in the body,
// even as an empty string; the normal form always sends its zero-default
// '' for every field, this seed script has to do the same explicitly.
// issuer_address_* is the type: 'address' composite's 7 sibling columns —
// issuer_address_number is the one nullable (*int) sub-column, safe to omit.
const ISSUER = {
  issuer_name: 'Northwind Logistics',
  issuer_address_number: 48,
  issuer_address_complement: '',
  issuer_address_street: 'Harbor Row',
  issuer_address_zip_code: '',
  issuer_address_city: 'Portsmouth',
  issuer_address_state: '',
  issuer_address_country: '',
  issuer_phone: '+1 555 0142',
  issuer_email: 'billing@northwindlogistics.example',
}
const PAYMENT_METHODS = ['Bank transfer', 'Credit card', 'Check'] as const
const PAYMENT_TERMS = ['Net 30', 'Net 15', 'Due on receipt'] as const

const CONTACT_COUNT = 10
const CRM_COUNT = 15
const TAG_LINKS_MAX_PER_CRM = 2
const INVOICE_COUNT = 6
const QUOTE_COUNT = 6
const DOC_LINES_MAX_PER_DOCUMENT = 3

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

function buildProducts(): Record<string, unknown>[] {
  return PRODUCTS.map((p) => ({
    name: p.name, reference: p.reference, unit: p.unit, unit_price: p.unit_price, tax_rate: p.tax_rate, description: p.description,
  }))
}

/**
 * Per product: a first variant with its Name left BLANK on purpose — exercises
 * warehouse.Handler's Create override, which defaults it from the product's own
 * name ("each product automatically references a variant") — then its named
 * variants, each with its own price. `products` is in PRODUCTS order (a failed
 * create drops out, hence the lookup by reference).
 */
function buildProductVariants(products: { id: string; reference?: unknown }[]): Record<string, unknown>[] {
  return products.flatMap((p) => {
    const def = PRODUCTS.find((d) => d.reference === p.reference)
    return [{ product_id: p.id }, ...(def?.variants ?? []).map((v) => ({ product_id: p.id, ...v }))]
  })
}

/** A 96×96 PNG: the product's color with a lighter diagonal band — enough for the
 * website's picture blocks to show something recognizable per product. */
function productPng([r, g, b]: readonly number[], shade: number): Buffer {
  const size = 96
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1)
    for (let x = 0; x < size; x += 1) {
      const band = Math.abs(x - y) < 16 ? 60 : 0
      const k = Math.min(1, 0.75 + shade * 0.15)
      raw[row + 1 + x * 3] = Math.min(255, r * k + band)
      raw[row + 2 + x * 3] = Math.min(255, g * k + band)
      raw[row + 3 + x * 3] = Math.min(255, b * k + band)
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A picture on every product and variant (the `picture` anchor; Go sets the flag). */
async function seedPictures(
  products: { id: string; reference?: unknown }[],
  variants: { id: string; product_id?: unknown }[],
): Promise<SeedEntityResult> {
  const result: SeedEntityResult = { entity: 'picture', created: 0, failed: 0, errors: [] }
  const colorOf = new Map(products.map((p) => [p.id, PRODUCTS.find((d) => d.reference === p.reference)?.color ?? [80, 80, 80]]))
  const targets = [
    ...products.map((p) => ({ table: 'product', id: p.id, color: colorOf.get(p.id)!, shade: 1 })),
    ...variants.map((v, i) => ({ table: 'product_variant', id: v.id, color: colorOf.get(String(v.product_id)) ?? [80, 80, 80], shade: i % 3 })),
  ]
  for (const t of targets) {
    const form = new FormData()
    form.set('table_name', t.table)
    form.set('record_id', t.id)
    form.set('field', 'picture')
    form.set('file', new Blob([new Uint8Array(productPng(t.color, t.shade))], { type: 'image/png' }), `${t.table}.png`)
    try {
      await uploadPicture(form)
      result.created += 1
    } catch (e) {
      result.failed += 1
      if (result.errors.length < 5) result.errors.push(e instanceof ApiError ? e.message : 'Unknown error')
    }
  }
  return result
}

/**
 * Shared shape behind buildInvoices/buildQuotes: sale.Invoice and sale.Quote
 * carry the same field set (module.go's doc comment on Quote) — only the
 * number prefix and status vocabulary differ per document kind.
 */
function buildDocuments(
  contacts: { id: string }[],
  count: number,
  numberPrefix: string,
  statuses: readonly string[],
): Record<string, unknown>[] {
  const year = new Date().getFullYear()
  return Array.from({ length: count }, (_, i) => {
    const first = pick(FIRST_NAMES)
    const last = pick(LAST_NAMES)
    const company = pick(COMPANIES)
    // A third of the batch has no linked contact, same reasoning as buildCrmRecords.
    const contact = contacts.length > 0 && Math.random() > 0.33 ? pick(contacts) : null
    const issueDate = new Date()
    issueDate.setDate(issueDate.getDate() - Math.floor(Math.random() * 60))
    const dueDate = new Date(issueDate)
    dueDate.setDate(dueDate.getDate() + 30)
    return {
      ...ISSUER,
      number: `${numberPrefix}-${year}-${String(i + 1).padStart(4, '0')}`,
      status: pick(statuses),
      issue_date: issueDate.toISOString().slice(0, 10),
      due_date: dueDate.toISOString().slice(0, 10),
      subject: 'Professional services',
      customer_id: contact?.id ?? null,
      customer_name: contact ? `${first} ${last}` : company,
      customer_email: fakeEmail(first, last, company),
      // customer_address_* — same NOT-NULL-string-columns rule as ISSUER
      // above; company doubles as filler street text, the rest stay blank.
      customer_address_complement: '',
      customer_address_street: company,
      customer_address_zip_code: '',
      customer_address_city: '',
      customer_address_state: '',
      customer_address_country: '',
      reference: `PO-${1000 + Math.floor(Math.random() * 9000)}`,
      payment_method: pick(PAYMENT_METHODS),
      payment_terms: pick(PAYMENT_TERMS),
      legal_notice: '',
    }
  })
}

/**
 * 1-3 lines per document, each striking a random product variant — the
 * backend snapshots Unit/TaxRate/UnitPrice from the variant's product and
 * rolls the parent document's totals up on every line write (handler.go's
 * recomputeTotals), so line bodies only need the variant + quantity.
 */
function buildDocumentLines(
  headerIdField: string,
  headers: { id: string }[],
  variants: { id: string }[],
): Record<string, unknown>[] {
  if (variants.length === 0) return []
  const lines: Record<string, unknown>[] = []
  for (const header of headers) {
    const lineCount = 1 + Math.floor(Math.random() * DOC_LINES_MAX_PER_DOCUMENT)
    for (let i = 0; i < lineCount; i += 1) {
      lines.push({
        [headerIdField]: header.id,
        variant_id: pick(variants).id,
        quantity: 1 + Math.floor(Math.random() * 5),
      })
    }
  }
  return lines
}

/**
 * One report_page_format row per standard preset (A4/A5/Letter/Legal, the
 * same PAPER_SIZE_PRESETS the page-format form's "Standard size" selector
 * offers) — Settings -> Global settings -> Reports ships with real defaults
 * instead of an empty table. Tagged to the caller's active company when
 * resolvable (report-settings.ts's createPageFormatForCompany does the same
 * for a manually created row); left untagged otherwise, same as any
 * pre-multi-company row (company.go's BackfillCompanyID sweeps those up).
 */
function buildPageFormats(companyId: string | null): Record<string, unknown>[] {
  return Object.entries(PAPER_SIZE_PRESETS).map(([name, size]) => ({
    name,
    ...size,
    ...(companyId ? { company_id: companyId } : {}),
  }))
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
 * Seed the workspace with fake contacts, CRM opportunities, tags, warehouse
 * products (described, with named variants and generated pictures), sale invoices/quotes (with their line items), and default report
 * page formats — through the ordinary entity API, in dependency order
 * (parents before the rows that reference their ids).
 */
export async function seedDemoData(volume: SeedVolume = 'light'): Promise<SeedResult> {
  if (!(await seedingAllowed())) {
    return { ok: false, message: 'Demo data seeding is disabled outside development.' }
  }
  if (volume === 'full') return seedFullVolume()

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

  const productsOutcome = await createMany<{ id: string; reference?: unknown }>('product', buildProducts())
  results.push(productsOutcome.result)

  const variantsOutcome = await createMany<{ id: string; product_id?: unknown }>(
    'product_variant',
    buildProductVariants(productsOutcome.records),
  )
  results.push(variantsOutcome.result)
  // Pictures need the S3-backed picture service; without it every upload fails,
  // reported like any other entity instead of aborting the seed.
  results.push(await seedPictures(productsOutcome.records, variantsOutcome.records))

  const invoicesOutcome = await createMany<{ id: string }>(
    'invoice',
    buildDocuments(contactsOutcome.records, INVOICE_COUNT, 'INV', INVOICE_STATUSES),
  )
  results.push(invoicesOutcome.result)

  const saleLinesOutcome = await createMany(
    'sale_line',
    buildDocumentLines('invoice_id', invoicesOutcome.records, variantsOutcome.records),
  )
  results.push(saleLinesOutcome.result)

  const quotesOutcome = await createMany<{ id: string }>(
    'quote',
    buildDocuments(contactsOutcome.records, QUOTE_COUNT, 'QUO', QUOTE_STATUSES),
  )
  results.push(quotesOutcome.result)

  const quoteLinesOutcome = await createMany(
    'quote_line',
    buildDocumentLines('quote_id', quotesOutcome.records, variantsOutcome.records),
  )
  results.push(quoteLinesOutcome.result)

  const preferences = await getMyLocalePreferences()
  const pageFormatsOutcome = await createMany(
    'report_page_format',
    buildPageFormats(preferences?.active_company?.id ?? null),
  )
  results.push(pageFormatsOutcome.result)

  return { ok: true, results }
}

/** The full volume: one Go call (it refuses outside development and when this
 * workspace was already fully seeded — both surface as the error message). */
async function seedFullVolume(): Promise<SeedResult> {
  try {
    const res = await apiRequest<{ results: { entity: string; created: number }[] }>('POST', '/dev_seed')
    // Go wrote straight to the tables: drop every cached list page it touched.
    for (const r of res.results) {
      if (!r.entity.includes(' ')) revalidateTag(r.entity, 'max')
    }
    return {
      ok: true,
      results: res.results.map((r) => ({ entity: r.entity, created: r.created, failed: 0, errors: [] })),
    }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : 'The full demo seed failed.' }
  }
}
