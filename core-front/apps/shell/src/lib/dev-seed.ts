'use server'
import { ApiError, createServerApiClient } from '@eerp/core-front/server'
import { seedingAllowed } from './dev-seed-allowed'
import { getMyLocalePreferences } from './preferences'
import { PAPER_SIZE_PRESETS } from '../../app/settings/appearance/page-formats/descriptors'

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

// warehouse.Product's small fixed catalog — a product catalog reads more
// realistically as concrete offerings than as randomly combined words, unlike
// contacts/CRM records above. tax_rate is a 0..1 ratio (see warehouse/module.go).
const PRODUCTS = [
  { name: 'Standard consulting hour', reference: 'CONS-STD', unit: 'hour', unit_price: 85, tax_rate: 0.2 },
  { name: 'Onboarding package', reference: 'ONB-PKG', unit: 'pcs', unit_price: 1200, tax_rate: 0.2 },
  { name: 'Support retainer (monthly)', reference: 'SUP-MO', unit: 'month', unit_price: 400, tax_rate: 0.2 },
  { name: 'Server rack unit', reference: 'HW-RACK', unit: 'pcs', unit_price: 650, tax_rate: 0.055 },
  { name: 'Training workshop (half day)', reference: 'TRN-HD', unit: 'pcs', unit_price: 300, tax_rate: 0.2 },
  { name: 'Custom integration', reference: 'DEV-INT', unit: 'pcs', unit_price: 2400, tax_rate: 0.2 },
] as const

const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'] as const
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const
const CURRENCIES = ['USD', 'EUR', 'GBP'] as const

// The seller's own letterhead — fixed rather than randomized per document,
// since every invoice/quote from one workspace is issued by the same
// company. sale.Invoice/Quote's issuer_*/payment_*/legal_notice columns are
// plain (non-pointer) strings — NOT NULL with no default — so Create 422s
// with VALIDATION_ERROR unless every one of them is present in the body,
// even as an empty string; the normal form always sends its zero-default
// '' for every field, this seed script has to do the same explicitly.
const ISSUER = {
  issuer_name: 'Northwind Logistics',
  issuer_address: '48 Harbor Row, Portsmouth',
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
  return PRODUCTS.map((p) => ({ ...p }))
}

/**
 * One variant per product, Name left BLANK on purpose — exercises
 * warehouse.Handler's Create override, which defaults it from the product's
 * own name ("each product automatically references a variant").
 */
function buildProductVariants(products: { id: string }[]): Record<string, unknown>[] {
  return products.map((p) => ({ product_id: p.id }))
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
      customer_address: company,
      currency: pick(CURRENCIES),
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
 * products, sale invoices/quotes (with their line items), and default report
 * page formats — through the ordinary entity API, in dependency order
 * (parents before the rows that reference their ids).
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

  const productsOutcome = await createMany<{ id: string }>('product', buildProducts())
  results.push(productsOutcome.result)

  const variantsOutcome = await createMany<{ id: string }>(
    'product_variant',
    buildProductVariants(productsOutcome.records),
  )
  results.push(variantsOutcome.result)

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
