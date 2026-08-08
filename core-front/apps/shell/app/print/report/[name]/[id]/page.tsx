import { notFound } from 'next/navigation'
import { ReportRenderer, type ReportDescriptor } from '@eerp/core-front'
import { createServerApiClient, moduleRegistry } from '@eerp/core-front/server'
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
// Being a plain async Server Component IS the `data-report-ready` guarantee:
// nothing below is returned to the caller until every await has resolved, so
// the marker's presence on the returned tree is never premature. That's also
// why this file has no test of its own — same reasoning
// apps/shell/app/page.test.tsx documents for not testing an async Server
// Component's own gating logic directly; the pure, testable surface is
// ReportRenderer itself (packages/core-front/src/views/report-renderer.test.tsx).

interface PrintReportPageProps {
  params: Promise<{ name: string; id: string }>
}

export default async function PrintReportPage({ params }: PrintReportPageProps) {
  const { name, id } = await params

  const descriptor = moduleRegistry.buildReportRegistry().get(name) as ReportDescriptor | undefined
  if (!descriptor) notFound()

  const client = createServerApiClient()
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

  return (
    <div data-report-ready="">
      <ReportRenderer descriptor={descriptor} record={record} />
    </div>
  )
}
