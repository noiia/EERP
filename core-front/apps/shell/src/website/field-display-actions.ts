'use server'
import { getIdentity } from '@/lib/session'
import { resolveDisplay, type FieldDisplay, type FieldKind } from './field-display'
import { presentValue, type Presented } from './field-format'
import { searchIcons, SUGGESTED_ICONS, type SiteIconData } from './field-icons'
import { fieldMetas } from './field-meta'
import { presentFields, siteFormatContext, type FieldColumn } from './present'
import { serverPublicSource } from './public-api'

// Server Actions behind the builder's field display settings (ADR-036). Staff only;
// they read published data through the same public API the site uses, so a preview
// shows exactly what a visitor would see.

export interface FieldInfo {
  kind: FieldKind
  /** The module's own label for the field, offered as a starting point for a custom label. */
  erpLabel?: string
}

/** What each field of `table` holds (its default kind), for the settings to adapt to. */
export async function describeFields(table: string, fields: string[]): Promise<Record<string, FieldInfo>> {
  if (!(await getIdentity()) || !table) return {}
  const sample = (await serverPublicSource.list(table, { page_size: 1 }).catch(() => null))?.records[0]
  const metas = fieldMetas(table, fields, sample)
  return Object.fromEntries(fields.map((f) => [f, { kind: metas[f].kind, ...(metas[f].label && { erpLabel: metas[f].label }) }]))
}

/** Icons matching `query` (empty: the ones suggested for `kind`), Font Awesome Free only. */
export async function searchFieldIcons(query: string, kind?: FieldKind): Promise<SiteIconData[]> {
  if (!(await getIdentity())) return []
  const suggested = [...((kind && SUGGESTED_ICONS[kind]) ?? []), ...SUGGESTED_ICONS.default]
  return searchIcons(query.slice(0, 60), 48, [...new Set(suggested)])
}

/** A stand-in value for a preview when no published row has one. */
function sampleFor(kind: FieldKind, country?: string): unknown {
  switch (kind) {
    case 'phone': return country === 'FR' ? '0612345678' : '+12125551234'
    case 'monetary': return 1250
    case 'integer': return 1250
    case 'decimal': return 1234.5
    case 'percent': return 0.25
    case 'rating': return 4
    case 'duration': return 90
    case 'boolean': return true
    case 'date': return '2026-03-01'
    case 'datetime': return '2026-03-01T14:30:00Z'
    case 'selection': return 'in_progress'
    case 'email': return 'contact@example.com'
    case 'url': return 'https://example.com'
    case 'multiline': return 'First line\nSecond line'
    case 'color': return '#1D4E89'
    default: return 'Sample text'
  }
}

export interface FieldPreview {
  column: FieldColumn
  value: Presented | null
  /** True when the value is a stand-in (no published row holds one). */
  sample: boolean
}

/** How `field` reads with `display`: a real published value when one exists, else a sample. */
export async function previewField(table: string, field: string, display: FieldDisplay): Promise<FieldPreview | null> {
  if (!(await getIdentity()) || !table || !field) return null
  const rows = (await serverPublicSource.list(table, { page_size: 20 }).catch(() => null))?.records ?? []
  const withValue = rows.find((r) => r[field] != null && r[field] !== '')
  const ctx = await siteFormatContext()
  const displays = { [field]: display }
  if (withValue) {
    const p = await presentFields({ table, fields: [field], records: [withValue], displays, source: serverPublicSource, ctx })
    const value = p.values[String(withValue.id)][field]
    if (value) return { column: p.columns[0], value, sample: false }
  }
  const p = await presentFields({ table, fields: [field], records: [], displays, source: serverPublicSource, ctx })
  const meta = fieldMetas(table, [field], rows[0])[field]
  const { format } = resolveDisplay(displays, field)
  const kind = format.as && format.as !== 'auto' ? format.as : meta.kind
  const shownKind = kind === 'relation' ? 'text' : kind // a sample can't be a real linked record
  return { column: p.columns[0], value: presentValue(sampleFor(shownKind, format.country || ctx.country), shownKind, format, ctx, meta.hints), sample: true }
}
