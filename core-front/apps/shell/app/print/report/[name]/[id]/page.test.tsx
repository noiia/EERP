import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { ReportDescriptor } from '@eerp/core-front'

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND') } }))
vi.mock('@/generated/generated-modules', () => ({}))
const reports = vi.hoisted(() => new Map<string, unknown>())
const client = vi.hoisted(() => ({
  get: vi.fn(), list: vi.fn(), getMyActiveCompany: vi.fn(), getReportsLayout: vi.fn(), getMyLocalePreferences: vi.fn(),
}))
const createServerApiClient = vi.hoisted(() => vi.fn(() => client))
const resolvePictureDataURL = vi.hoisted(() => vi.fn(async () => 'data:image/png;base64,AAA'))
vi.mock('@eerp/core-front/server', () => ({
  moduleRegistry: { buildReportRegistry: () => reports },
  createServerApiClient,
  resolvePictureDataURL,
}))
const rendered = vi.hoisted(() => ({ props: null as null | { record: Record<string, unknown>; locale: string | null } }))
vi.mock('@eerp/core-front', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front')>()
  return {
    ...actual,
    ReportRenderer: (p: { record: Record<string, unknown>; locale: string | null }) => { rendered.props = p; return <div data-testid="report" /> },
    translationRegistry: { locales: () => [{ locale: 'fr' }] },
  }
})

import PrintReportPage from './page'

const invoice: ReportDescriptor = {
  name: 'sale.invoice',
  entity: 'invoice',
  permissions: [],
  chrome: { header: true, footer: true },
  pageFormat: 'A5',
  layout: [
    { kind: 'image', source: 'logo' },
    { kind: 'image', source: 'stamp' },
    { kind: 'section', children: [{ kind: 'field', name: 'issuer_name', label: 'Issuer', companyFallback: 'name' }, { kind: 'field', name: 'issuer_phone', label: 'Phone', companyFallback: 'phone' }] },
    { kind: 'table', source: 'lines', columns: [], relation: { entity: 'sale_line', inverseField: 'invoice_id' } },
  ],
} as unknown as ReportDescriptor

const page = (name = 'sale.invoice', token: string | undefined = 'tok') =>
  PrintReportPage({ params: Promise.resolve({ name, id: 'i1' }), searchParams: Promise.resolve({ token }) })

beforeEach(() => {
  reports.clear()
  reports.set('sale.invoice', invoice)
  reports.set('core.default', { ...invoice, name: 'core.default', abstract: true })
  rendered.props = null
  resolvePictureDataURL.mockClear()
  client.get.mockReset().mockImplementation(async (entity: string) =>
    entity === 'invoice'
      ? { id: 'i1', logo: true, stamp: false, issuer_name: 'Own name', issuer_phone: '' }
      : { id: 'c1', name: 'Acme', phone: '0102', currency: 'EUR', logo: true })
  client.list.mockReset().mockImplementation(async (entity: string) =>
    entity === 'sale_line' ? [{ id: 'l1' }] : [{ name: 'A5', width: 148, height: 210, unit: 'mm', padding: 12, footer: 'Format footer', address: null }])
  client.getMyActiveCompany.mockReset().mockResolvedValue({ id: 'c1' })
  client.getReportsLayout.mockReset().mockResolvedValue({ footer: 'Global footer', address: '1 Main St' })
  client.getMyLocalePreferences.mockReset().mockResolvedValue({ preferred_locale: 'fr', default_locale: null })
})

describe('PrintReportPage', () => {
  it('404s an unknown or abstract report, and a request without a token', async () => {
    await expect(page('nope')).rejects.toThrow('NOT_FOUND')
    await expect(page('core.default')).rejects.toThrow('NOT_FOUND')
    await expect(page('sale.invoice', '')).rejects.toThrow('NOT_FOUND')
  })

  it('404s a record the token cannot read', async () => {
    client.get.mockRejectedValue(new Error('forbidden'))
    await expect(page()).rejects.toThrow('NOT_FOUND')
  })

  it('prints the record with its pictures, lines, company fallbacks, chrome and the reader\'s language', async () => {
    const { container, getByTestId } = render(await page())
    expect(createServerApiClient).toHaveBeenCalledWith('tok')
    expect(getByTestId('report')).toBeTruthy()
    expect(rendered.props?.record).toMatchObject({
      logo: 'data:image/png;base64,AAA', stamp: null, lines: [{ id: 'l1' }], currency: 'EUR',
      issuer_name: 'Own name', // the record's own value is never overwritten
      issuer_phone: '0102', // empty: the active company's
    })
    expect(rendered.props?.locale).toBe('fr')
    const root = container.querySelector('[data-report-ready]') as HTMLElement
    expect(root.style.getPropertyValue('--eerp-report-text')).not.toBe('')
    expect(container.querySelector('style')?.textContent).toBe('@page { size: 148mm 210mm; }')
    expect(container.querySelector('.eerp-report-chrome-address')?.textContent).toBe('1 Main St')
    expect(container.querySelector('.eerp-report-chrome-logo')?.getAttribute('src')).toBe('data:image/png;base64,AAA')
    expect(container.querySelector('.eerp-report-chrome-footer')?.textContent).toBe('Format footer')
  })

  it('degrades every optional read to plain output, never a 404', async () => {
    reports.set('sale.invoice', { ...invoice, chrome: undefined, pageFormat: undefined })
    client.list.mockRejectedValue(new Error('down'))
    client.getMyActiveCompany.mockRejectedValue(new Error('down'))
    client.getReportsLayout.mockRejectedValue(new Error('down'))
    client.getMyLocalePreferences.mockRejectedValue(new Error('down'))
    const { container } = render(await page())
    expect(rendered.props?.record).toMatchObject({ lines: [], currency: '', issuer_phone: '' })
    expect(rendered.props?.locale).toBeNull()
    expect(container.querySelector('style')).toBeNull()
    expect(container.querySelector('.eerp-report-chrome-header')).toBeNull()
    expect(container.querySelector('.eerp-report-chrome-footer')).toBeNull()
  })

  it('prints no header logo for a company without one, nor a missing format', async () => {
    client.get.mockImplementation(async (entity: string) => (entity === 'invoice' ? { id: 'i1' } : { id: 'c1', logo: false }))
    client.list.mockImplementation(async (entity: string) => (entity === 'sale_line' ? [] : []))
    client.getReportsLayout.mockResolvedValue({ footer: '', address: '' })
    const { container } = render(await page())
    expect(container.querySelector('.eerp-report-chrome-header')).toBeNull()
    expect(container.querySelector('.eerp-report-chrome-footer')).toBeNull()
    expect(container.querySelector('style')).toBeNull()
  })
})
