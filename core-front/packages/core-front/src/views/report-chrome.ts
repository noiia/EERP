// Effective PDF report chrome resolution (docs/roadmaps/pdf-reports.md's
// Reports settings subsection) — a pure function, deliberately independent
// of React/Next, so it's unit-testable without mocking a Server Component.
// The print route (apps/shell/app/print/report/[name]/[id]/page.tsx) is the
// one caller: it fetches the global reports.layout setting and, when the
// ReportDescriptor names one, a report_page_format row, then calls
// resolveReportChrome to get the values it actually renders.
//
// Padding and colors have NO editable global setting — only a built-in
// default constant, overridable per page format. Footer/address DO have a
// global-editable setting (Settings -> Global settings -> Reports),
// likewise overridable per page format. See the roadmap's scope note.

/** The stored value of app_settings key `reports.layout` (Go: reportsLayout). */
export interface ReportChromeGlobal {
  footer: string
  address: string
}

/** A report_page_format row's JSON shape, as Go's generic CRUD returns it. */
export interface ReportPageFormatRow {
  name: string
  width: number
  height: number
  unit: 'px' | 'cm' | 'in'
  padding: number | null
  color_text: string | null
  color_text_muted: string | null
  color_border: string | null
  color_accent: string | null
  footer: string | null
  address: string | null
}

export interface EffectiveReportChrome {
  paddingPx: number
  colors: { text: string; textMuted: string; border: string; accent: string }
  footer: string
  address: string
  /** "<w><unit> <h><unit>" for an `@page { size: ... }` rule, or null when no page format is set (Chrome's own default page size applies). */
  pageSizeCss: string | null
}

export const DEFAULT_PADDING_PX = 100
export const DEFAULT_COLORS = {
  text: '#222',
  textMuted: '#333',
  border: '#ccc',
  accent: '#f2f2f2',
} as const

/**
 * Resolve the effective padding/colors/footer/address/page-size for one
 * report render. `format` is the report_page_format row named by the
 * descriptor's `pageFormat`, or null when the descriptor doesn't opt into
 * one — every field falls back independently, so a format that only sets an
 * accent color still inherits the built-in padding and the global footer.
 */
export function resolveReportChrome(
  global: ReportChromeGlobal,
  format: ReportPageFormatRow | null,
): EffectiveReportChrome {
  return {
    paddingPx: format?.padding ?? DEFAULT_PADDING_PX,
    colors: {
      text: format?.color_text ?? DEFAULT_COLORS.text,
      textMuted: format?.color_text_muted ?? DEFAULT_COLORS.textMuted,
      border: format?.color_border ?? DEFAULT_COLORS.border,
      accent: format?.color_accent ?? DEFAULT_COLORS.accent,
    },
    footer: format?.footer ?? global.footer,
    address: format?.address ?? global.address,
    pageSizeCss: format ? `${format.width}${format.unit} ${format.height}${format.unit}` : null,
  }
}
