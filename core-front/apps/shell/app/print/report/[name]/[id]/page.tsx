import { notFound } from 'next/navigation'
import type { CSSProperties } from 'react'
import {
  resolveReportChrome,
  ReportRenderer,
  reportCompanyFallbackFields,
  reportImageSources,
  type ReportDescriptor,
  type ReportPageFormatRow,
} from '@eerp/core-front'
import { createServerApiClient, moduleRegistry, resolvePictureDataURL } from '@eerp/core-front/server'
// Side-effect import: registers every discovered module's reports into the
// shared registry — the same manifest the catch-all route and the App Store
// page import.
import '@/generated/generated-modules'

// The pdf-service's ONE entry point (docs/adr/ADR-010, docs/roadmaps/
// pdf-reports.md Phase 2): a generic print target for ANY registered
// ReportDescriptor, resolved by NAME rather than the catch-all's path
// matching (a report has no on-screen route of its own).
//
// Deliberately carries NO requireAuth()/session check — per ADR-010 decision
// 4, this route is reachable only over an internal, trusted network path the
// core-signed URL controls. Authorization happens in Go (Phase 3's
// POST /api/v1/reports/:name/:id/pdf) BEFORE pdf-service ever requests this
// URL, not here — the root layout's own getIdentity() already degrades to an
// anonymous render with no cookie present, so this needs no special-casing
// there either.
//
// This route's OWN outbound call to Go still needs a Bearer token, though —
// Go authorizes every request unconditionally, network trust or not — and
// pdf-service's headless Chrome carries no session cookie to supply one.
// Phase 3 closes that gap: Go mints a short-lived, report-scoped access
// token (60s TTL) and embeds it as this URL's `?token=`, which
// createServerApiClient's tokenOverride param uses instead of the (absent)
// cookie. A missing/expired/invalid token surfaces as notFound() below, the
// same as a missing record — there's no user here to show an error to.
//
// Padding/colors/page-size/footer/address (docs/roadmaps/pdf-reports.md's
// Reports settings subsection) are resolved here, once, via the pure
// resolveReportChrome — global reports.layout defaults, overridden per field
// by a report_page_format row when descriptor.pageFormat names one. Neither
// read can turn a printable record into a 404: chrome is additive styling on
// top of ReportRenderer's own output, never required data.
//
// Being a plain async Server Component IS the `data-report-ready` guarantee:
// nothing below is returned to the caller until every await has resolved, so
// the marker's presence on the returned tree is never premature. That's also
// why this file has no test of its own — same reasoning
// apps/shell/app/page.test.tsx documents for not testing an async Server
// Component's own gating logic directly; the pure, testable surface is
// ReportRenderer itself (packages/core-front/src/views/report-renderer.test.tsx).

interface PrintReportPageProps {
  params: Promise<{ name: string; id: string }>
  searchParams: Promise<{ token?: string }>
}

export default async function PrintReportPage({ params, searchParams }: PrintReportPageProps) {
  const { name, id } = await params
  const { token } = await searchParams

  const descriptor = moduleRegistry.buildReportRegistry().get(name) as ReportDescriptor | undefined
  if (!descriptor) notFound()
  if (!token) notFound()

  const client = createServerApiClient(token)
  let record: Record<string, unknown> | null = null
  try {
    record = await client.get<Record<string, unknown>>(descriptor.entity, id)
  } catch {
    // A missing record or a denied read both surface as "nothing to print" —
    // there is no user here to show an error to, only a browser waiting on
    // data-report-ready that will now simply never appear (pdf-service's own
    // request timeout is the caller's backstop, see tools/pdf-service).
  }
  if (!record) notFound()

  // Picture-backed fields (docs/adr/ADR-011): `record[field]` is still the
  // raw boolean flag (true ⇔ a picture exists on that anchor) — resolve each
  // one declared by an `image` node into a `data:` URL now, inlined into the
  // HTML this Server Component returns, so pdf-service's headless Chrome
  // never needs its own auth to fetch the bytes at print time.
  for (const field of reportImageSources(descriptor)) {
    record[field] =
      record[field] === true
        ? await resolvePictureDataURL({ table: descriptor.entity, recordId: id, field }, token)
        : null
  }

  // Multi-company: fields opted into companyFallback (e.g. sale.invoice's
  // issuer_name/address/phone/email) fall back to the printing user's
  // active company profile when the record's own value is empty — never
  // overwriting a value the record actually has. Same additive, never-404
  // posture as the chrome reads below: a failed company lookup just leaves
  // the record's own (possibly empty) fields as-is.
  const fallbackFields = reportCompanyFallbackFields(descriptor)
  if (fallbackFields.length > 0) {
    const activeCompany = await client.getMyActiveCompany().catch(() => null)
    const company = activeCompany
      ? await client.get<Record<string, unknown>>('company', activeCompany.id).catch(() => null)
      : null
    if (company) {
      for (const { recordField, companyField } of fallbackFields) {
        if (!record[recordField]) record[recordField] = company[companyField] ?? ''
      }
    }
  }

  // Effective chrome (docs/roadmaps/pdf-reports.md's Reports settings):
  // global footer/address, plus size/padding/colors/footer/address from the
  // named report_page_format row when the descriptor opts into one. Both
  // reads degrade to "no override" on any failure (missing permission, no
  // such format) — chrome is additive styling, never required data, so it
  // must never turn a printable record into a 404.
  const global = await client.getReportsLayout().catch(() => ({ footer: '', address: '' }))
  const format = descriptor.pageFormat
    ? await client
        .list<ReportPageFormatRow>('report_page_format', { filter: { name: descriptor.pageFormat } })
        .then((rows) => rows[0] ?? null)
        .catch(() => null)
    : null
  const chrome = resolveReportChrome(global, format)

  return (
    <div
      data-report-ready=""
      style={
        {
          '--eerp-report-text': chrome.colors.text,
          '--eerp-report-text-muted': chrome.colors.textMuted,
          '--eerp-report-border': chrome.colors.border,
          '--eerp-report-accent': chrome.colors.accent,
        } as CSSProperties
      }
    >
      {chrome.pageSizeCss && <style>{`@page { size: ${chrome.pageSizeCss}; }`}</style>}
      <div className="eerp-report-content" style={{ padding: chrome.paddingPx }}>
        <ReportRenderer descriptor={descriptor} record={record} />
      </div>
      {chrome.footer && <div className="eerp-report-chrome-footer">{chrome.footer}</div>}
      {chrome.address && <div className="eerp-report-chrome-address">{chrome.address}</div>}
    </div>
  )
}
