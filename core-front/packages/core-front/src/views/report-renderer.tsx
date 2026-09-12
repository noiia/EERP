import { DEFAULT_NUMBER_FORMAT, formatNumber } from './format-store'
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
}

export function ReportRenderer({ descriptor, record }: ReportRendererProps) {
  return (
    <>
      {descriptor.layout.map((node, i) => (
        <ReportNodeView key={i} node={node} record={record} />
      ))}
    </>
  )
}

function ReportNodeView({ node, record }: { node: ReportNode; record: Record<string, unknown> }) {
  switch (node.kind) {
    case 'section':
      return (
        <div className={node.className}>
          {node.children.map((child, i) => (
            <ReportNodeView key={i} node={child} record={record} />
          ))}
        </div>
      )
    case 'field':
      return <div className={node.className}>{formatFieldValue(record[node.name], node.format)}</div>
    case 'table':
      return <ReportTableView node={node} record={record} />
    case 'text':
      return <div className={node.className}>{node.text}</div>
    case 'image': {
      const value = record[node.source]
      if (typeof value !== 'string' || value === '') return null
      // Plain <img>, not next/image: this is a headless-Chromium print
      // target, not an interactive page — no lazy-loading/CDN story applies.
      return <img className={node.className} src={value} alt={node.alt ?? ''} />
    }
    case 'pageBreak':
      // The print route's stylesheet owns page-break-before: always for this
      // class — ReportRenderer only names the hook, never inlines print CSS.
      return <div className="eerp-page-break" />
  }
}

function ReportTableView({ node, record }: { node: ReportTableNode; record: Record<string, unknown> }) {
  const value = record[node.source]
  const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : []
  return (
    <table className={node.className}>
      <thead>
        <tr>
          {node.columns.map((col) => (
            <th key={col.name}>{col.label}</th>
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

// ponytail: runtime-default locale only (Node's default, typically en-US) —
// no i18n integration. Wire resolveEffectiveLocale() through here if a report
// ever needs translated date formatting; every other value formatter in this
// engine is already locale-aware (useNumberFormat), this one deliberately
// isn't yet, since no report has asked for it.
function formatFieldValue(value: unknown, format?: ReportFieldNode['format']): string {
  if (value == null) return ''
  if (format === 'number' && typeof value === 'number') {
    return formatNumber(value, DEFAULT_NUMBER_FORMAT)
  }
  if ((format === 'date' || format === 'datetime') && typeof value === 'string') {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return format === 'date' ? date.toLocaleDateString() : date.toLocaleString()
  }
  return String(value)
}
