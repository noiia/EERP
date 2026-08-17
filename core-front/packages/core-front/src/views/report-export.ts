// The client-side half of "print a report" (docs/adr/ADR-010, ADR-011): POSTs
// to this BFF's /api/reports/:name/:id, which mints a short-lived download
// URL (itself a BFF proxy path, /api/reports/pdf?key=...). A module's
// registerMenuAction/registerHeaderButtonAction handler is the intended
// caller; kept here, not inlined per-module, so there is exactly one tested
// implementation of the fetch dance — module view files' own tsconfig has no
// DOM lib (descriptors + orchestration only), so `fetch`/`window` must stay
// engine-side, never called directly from a module's views file.
async function requestReportDownloadURL(reportName: string, recordId: string): Promise<string> {
  const res = await fetch(`/api/reports/${encodeURIComponent(reportName)}/${encodeURIComponent(recordId)}`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error('export failed')
  const body = (await res.json()) as { download_url: string }
  return body.download_url
}

/** Generate a report and open its PDF in a new tab — the form actions menu's
 * Print entry point (ADR-011). */
export async function exportReportPDF(reportName: string, recordId: string): Promise<void> {
  window.open(await requestReportDownloadURL(reportName, recordId), '_blank')
}

/**
 * Generate a report and return its PDF bytes directly, instead of opening
 * them — for a handler that needs to DO something with the bytes (e.g.
 * property_management's Generate Rent Receipt re-uploading them as the
 * receipt's own fixed snapshot, core/modules/propertymanagement/views/
 * PropertyManagementViews.ts) rather than just showing them to the user.
 */
export async function fetchReportPDF(reportName: string, recordId: string): Promise<Blob> {
  const downloadURL = await requestReportDownloadURL(reportName, recordId)
  const file = await fetch(downloadURL)
  if (!file.ok) throw new Error('report download failed')
  return file.blob()
}
