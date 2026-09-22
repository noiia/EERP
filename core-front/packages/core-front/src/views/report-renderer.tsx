import { evaluateCondition } from './descriptor'
import { DEFAULT_NUMBER_FORMAT, formatNumber } from './format-store'
import { translate } from '../i18n/translate'
import type { ReportDescriptor, ReportFieldNode, ReportNode, ReportTableNode } from './report-descriptor'

// Renders a ReportDescriptor's layout tree into plain DOM for a print target.
// Deliberately NOT 'use client' and uses no hooks: unlike FormRenderer/
// LayoutForm (draft/dirty client state), a report is a read-only snapshot the
// print route renders once, server-side, and tools/pdf-service prints as-is.
// Styling is entirely through each node's `className` (Tailwind/MUI utility
// classes the print route's page supplies) rather than MUI components — a
// headless-Chromium print target has no interactive affordances to justify
// MUI's JS runtime.

export interface ReportRendererProps {
  descriptor: ReportDescriptor
  record: Record<string, unknown>
  /**
   * The locale to render report-authored literal strings in (a `text` node's
   * own text, a table column's `label`) — null/omitted renders the source
   * (English) strings, same as `translate()`'s own fallback. A `field` node
   * never needs this: it prints a record VALUE, not a label, and any label
   * a form/list shows for that same field lives in the entity's own
   * ViewDescriptor + i18n catalog, resolved long before a report ever runs.
   * The print route (apps/shell/app/print/report) is the one caller that
   * resolves a real locale, from the SAME preferred/default preference
   * precedence every other server render uses (resolveEffectiveLocale) —
   * this component stays a plain prop take, no i18n store/hook, since it's a
   * Server Component with no client state to subscribe from.
   */
  locale?: string | null
}

export function ReportRenderer({ descriptor, record, locale = null }: ReportRendererProps) {
  return (
    <>
      {descriptor.layout.map((node, i) => (
        <ReportNodeView key={i} node={node} record={record} locale={locale} />
      ))}
    </>
  )
}

function ReportNodeView({
  node,
  record,
  locale,
}: {
  node: ReportNode
  record: Record<string, unknown>
  locale: string | null
}) {
  switch (node.kind) {
    case 'section':
      if (node.display && !evaluateCondition(node.display, record)) return null
      return (
        <div className={node.className}>
          {node.children.map((child, i) => (
            <ReportNodeView key={i} node={child} record={record} locale={locale} />
          ))}
        </div>
      )
    case 'field':
      if (node.display && !evaluateCondition(node.display, record)) return null
      return <div className={node.className}>{formatFieldValue(record[node.name], node.format, record.currency)}</div>
    case 'table':
      return <ReportTableView node={node} record={record} locale={locale} />
    case 'text':
      return <div className={node.className}>{translate(locale, node.text)}</div>
    case 'image': {
      const value = record[node.source]
      if (typeof value !== 'string' || value === '') return null
      // Plain <img>, not next/image: this is a headless-Chromium print
      // target, not an interactive page — no lazy-loading/CDN story applies.
      return <img className={node.className} src={value} alt={node.alt ? translate(locale, node.alt) : ''} />
    }
    case 'pageBreak':
      // The print route's stylesheet owns page-break-before: always for this
      // class — ReportRenderer only names the hook, never inlines print CSS.
      return <div className="eerp-page-break" />
  }
}

function ReportTableView({
  node,
  record,
  locale,
}: {
  node: ReportTableNode
  record: Record<string, unknown>
  locale: string | null
}) {
  const value = record[node.source]
  const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : []
  return (
    <table className={node.className}>
      <thead>
        <tr>
          {node.columns.map((col) => (
            <th key={col.name}>{translate(locale, col.label)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {node.columns.map((col) => (
              <td key={col.name}>{formatFieldValue(row[col.name])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ponytail: runtime-default locale only (Node's default, typically en-US) for
// DATE FORMATTING specifically — the `locale` prop above only translates
// report-authored strings (text/column labels) via the gettext catalogs,
// unrelated to Date#toLocaleDateString's own locale argument. Thread `locale`
// through here too (`date.toLocaleDateString(locale ?? undefined)`) if a
// report ever needs the date's own digit grouping/month-name locale to
// follow the same preference; every other value formatter in this engine is
// already locale-aware (useNumberFormat), this one deliberately isn't yet,
// since no report has asked for it.
function formatFieldValue(value: unknown, format?: ReportFieldNode['format'], currency?: unknown): string {
  if (value == null) return ''
  if (format === 'number' && typeof value === 'number') {
    return formatNumber(value, DEFAULT_NUMBER_FORMAT)
  }
  if (format === 'monetary' && typeof value === 'number') {
    const amount = formatNumber(value, DEFAULT_NUMBER_FORMAT)
    return currency ? `${amount} ${String(currency)}` : amount
  }
  if ((format === 'date' || format === 'datetime') && typeof value === 'string') {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return format === 'date' ? date.toLocaleDateString() : date.toLocaleString()
  }
  return String(value)
}
