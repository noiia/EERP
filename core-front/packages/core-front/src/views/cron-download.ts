// The client-side half of "download a cron_history run's log file"
// (docs/adr/ADR-016-cron-scheduler.md). A plain browser navigation to the
// BFF route works because it's a same-origin GET behind the httpOnly
// session cookie — no fetch-then-blob dance needed (unlike report-export.ts's
// exportReportPDF, which first has to POST to GENERATE the file). Kept here,
// not inlined in core/modules/cron/views/CronViews.ts, for the same reason
// exportReportPDF isn't inlined per-module: one tested implementation, and
// the module's own tsconfig has no "dom" lib (it never otherwise touches
// `window`).
export function downloadCronHistoryLog(recordId: string): void {
  window.open(`/api/cron-history/${encodeURIComponent(recordId)}/log`, '_blank')
}
