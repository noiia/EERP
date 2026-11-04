import 'server-only'
import type { FieldDescriptor } from '@eerp/core-front'
import { moduleRegistry } from '@eerp/core-front/server'
import '@/generated/generated-modules'
import type { FieldKind } from './field-display'
import type { KindHints } from './field-format'

// What kind of value a published column holds (ADR-036). Go's public API returns bare
// JSON values, but each module already declares its fields for the ERP (type + widget
// in its form descriptor): that declaration is the source of truth here, so a field
// reads the same on the site as in the ERP. Tables no module describes, and plain
// number/text fields whose name says more (`unit_price`, `email`), fall back to the
// column name, then to the value itself.

export interface FieldMeta {
  kind: FieldKind
  hints: KindHints
  /** The module's own (staff-facing) label: offered in the editor, never shown by default. */
  label?: string
  /** A many2one's target table and display column. */
  relation?: { table: string; labelField: string }
}

const MONEY_NAME = /(^|_)(price|amount|total|subtotal|cost|fee|fees|salary|budget|revenue|balance)(_|$)/
const PHONE_NAME = /(^|_)(phone|mobile|tel|telephone|fax)(_|$)/
const EMAIL_NAME = /(^|_)e?mail(_|$)/
const URL_NAME = /(^|_)(url|website|site|link|homepage)(_|$)/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** The kind a declared ERP field maps to. */
export function kindOfDescriptor(f: FieldDescriptor): FieldMeta {
  const hints: KindHints = {
    ...(typeof f.widgetOptions?.decimals === 'number' && { decimals: f.widgetOptions.decimals }),
    ...(f.widgetOptions?.base === 'percent' && { percentBase: 'percent' as const }),
    ...(typeof f.widgetOptions?.max === 'number' && { max: f.widgetOptions.max }),
  }
  const meta = (kind: FieldKind): FieldMeta => ({ kind, hints, label: f.label })
  switch (f.type) {
    case 'text':
      switch (f.widget) {
        case 'long': case 'html': return meta('multiline')
        case 'phone': return meta('phone')
        case 'url': return meta('url')
        case 'color': return meta('color')
        default: return meta(byName(f.name, 'text'))
      }
    case 'number':
      switch (f.widget) {
        case 'monetary': return meta('monetary')
        case 'percent': return meta('percent')
        case 'stars': return meta('rating')
        case 'duration': return meta('duration')
        case 'phone': return meta('phone')
        case 'int': return meta('integer')
        default: return meta(byName(f.name, 'decimal'))
      }
    case 'boolean': return meta('boolean')
    case 'date': return meta(f.widget === 'datetime' ? 'datetime' : 'date')
    case 'selection': return meta('selection')
    case 'relation':
      return f.relation?.kind === 'many2one'
        ? { kind: 'relation', hints, label: f.label, relation: { table: f.relation.entity, labelField: f.relation.labelField ?? 'name' } }
        : meta('text')
    default: return meta('text')
  }
}

/** A plain text/number field whose column name tells what it holds. */
function byName(name: string, fallback: FieldKind): FieldKind {
  if (fallback === 'decimal' && MONEY_NAME.test(name)) return 'monetary'
  if (PHONE_NAME.test(name)) return 'phone'
  if (fallback === 'text' && EMAIL_NAME.test(name)) return 'email'
  if (fallback === 'text' && URL_NAME.test(name)) return 'url'
  return fallback
}

/** A field no module describes: its name, then its value's shape. */
export function inferKind(name: string, sample: unknown): FieldKind {
  if (typeof sample === 'boolean') return 'boolean'
  if (typeof sample === 'number') return byName(name, Number.isInteger(sample) && !MONEY_NAME.test(name) ? 'integer' : 'decimal')
  if (typeof sample === 'string') {
    if (DATE_ONLY.test(sample)) return 'date'
    if (DATE_TIME.test(sample)) return 'datetime'
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sample)) return 'email'
    if (/^https?:\/\//i.test(sample)) return 'url'
    if (sample.includes('\n')) return 'multiline'
  }
  return byName(name, 'text')
}

/** The ERP's declaration of `table`'s fields, by name (empty when no module describes it). */
export function declaredFields(table: string): Map<string, FieldDescriptor> {
  const d = moduleRegistry.formDescriptorFor(table)
  return new Map((d?.fields ?? []).map((f) => [f.name, f]))
}

/** Every field's meta for `table`, from its declaration or, failing that, `sample` (one row). */
export function fieldMetas(table: string, fields: string[], sample?: Record<string, unknown>): Record<string, FieldMeta> {
  const declared = declaredFields(table)
  return Object.fromEntries(fields.map((name) => {
    const d = declared.get(name)
    return [name, d ? kindOfDescriptor(d) : { kind: inferKind(name, sample?.[name]), hints: {} }]
  }))
}
