// The client-side half of "print a report" (docs/adr/ADR-010, ADR-011): POSTs
// to this BFF's /api/reports/:name/:id, which mints a short-lived download
// URL (itself a BFF proxy path, /api/reports/pdf?key=...) and opens it — the
// same call the old, always-on ReportExportButton made before the form
// actions menu (ADR-011) replaced it as the print entry point. A module's
// registerMenuAction handler is the intended caller; kept here, not inlined
// per-module, so there is exactly one tested implementation of the fetch dance.
export async function exportReportPDF(reportName: string, recordId: string): Promise<void> {
  const res = await fetch(`/api/reports/${encodeURIComponent(reportName)}/${encodeURIComponent(recordId)}`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error('export failed')
  const body = (await res.json()) as { download_url: string }
  window.open(body.download_url, '_blank')
}
