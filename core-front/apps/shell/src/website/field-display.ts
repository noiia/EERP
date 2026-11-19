// How a website block shows one field (ADR-036): its label, its formatting and an
// optional icon. Presentation metadata stored in the block's config
// (`config.field_display[<column>]`, and `config.related.field_display` for a detail
// block's related rows) — never on the business field, never a copy of its value.
//
// Every property is optional: an absent entry (every block saved before this existed)
// reads as the defaults below, so existing sites need no migration. Server-safe and
// client-safe: no React, no I/O.

/** What a value is, deciding its default presentation (see field-format.ts). */
export const FIELD_KINDS = [
  'text', 'multiline', 'email', 'url', 'phone', 'monetary', 'integer', 'decimal', 'percent',
  'rating', 'duration', 'boolean', 'date', 'datetime', 'selection', 'relation', 'color',
] as const
export type FieldKind = (typeof FIELD_KINDS)[number]

export const ICON_FAMILIES = ['solid', 'regular', 'brands'] as const
export type IconFamily = (typeof ICON_FAMILIES)[number]
export type IconPosition = 'before' | 'after'
export type IconSpacing = 'tight' | 'normal' | 'loose'
/** Icon colors stay within the site theme: the text's own, its muted tone, or the link color. */
export type IconColor = 'inherit' | 'muted' | 'accent'
export type DateStyle = 'short' | 'medium' | 'long'

export interface FieldFormat {
  /** 'auto' (default): the kind the field's type implies. Else force one. */
  as?: FieldKind | 'auto'
  /** Phone: the country a number without +prefix belongs to (ISO 3166 alpha-2). */
  country?: string
  /** Monetary: a fixed currency (ISO 4217) instead of the workspace's. */
  currency?: string
  /** Monetary: a column of the same record holding the currency code. */
  currency_field?: string
  /** Number, monetary, percent: digits after the separator (else the type's/currency's own). */
  decimals?: number
  date_style?: DateStyle
  /** Datetime: an IANA zone (e.g. Europe/Paris) instead of the server's. */
  timezone?: string
  /** Boolean: the words shown for true/false (else Yes/No). */
  true_label?: string
  false_label?: string
}

export interface FieldIcon {
  /** A Font Awesome Free icon name, e.g. 'phone', 'envelope', 'instagram'. */
  name: string
  family?: IconFamily
  position?: IconPosition
  spacing?: IconSpacing
  color?: IconColor
}

export interface FieldDisplay {
  hide_label?: boolean
  custom_label?: string
  format?: FieldFormat
  icon?: FieldIcon | null
}
export type FieldDisplays = Record<string, FieldDisplay>

/** The resolved icon settings, with defaults filled in. */
export type ResolvedIcon = Required<FieldIcon>

/** The field's display settings with every default filled in; missing or malformed
 * parts (hand-edited JSON, an older shape) fall back instead of failing. */
export function resolveDisplay(displays: unknown, field: string): {
  hideLabel: boolean
  customLabel: string
  format: FieldFormat
  icon: ResolvedIcon | null
} {
  const all = displays && typeof displays === 'object' ? (displays as Record<string, unknown>) : {}
  const d = (all[field] && typeof all[field] === 'object' ? all[field] : {}) as FieldDisplay
  const icon = d.icon && typeof d.icon === 'object' && typeof d.icon.name === 'string' && d.icon.name ? d.icon : null
  return {
    hideLabel: d.hide_label === true,
    customLabel: typeof d.custom_label === 'string' ? d.custom_label.trim() : '',
    format: d.format && typeof d.format === 'object' ? d.format : {},
    icon: icon && {
      name: icon.name,
      family: ICON_FAMILIES.includes(icon.family as IconFamily) ? (icon.family as IconFamily) : 'solid',
      position: icon.position === 'after' ? 'after' : 'before',
      spacing: icon.spacing === 'tight' || icon.spacing === 'loose' ? icon.spacing : 'normal',
      color: icon.color === 'muted' || icon.color === 'accent' ? icon.color : 'inherit',
    },
  }
}

/** A column name as a readable default label: `unit_price` → `Unit price`. */
export const humanize = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/**
 * The label shown beside a field's value, or null for none.
 *
 * | hide_label | custom_label | shown           |
 * |------------|--------------|-----------------|
 * | false      | empty        | `fallback`      |
 * | false      | set          | custom label    |
 * | true       | either       | none            |
 *
 * Hiding wins. The accessible name is separate (`accessibleLabel`): a hidden label is
 * still read out, so a bare value is never announced without context.
 */
export function visibleLabel(display: { hideLabel: boolean; customLabel: string }, fallback: string): string | null {
  if (display.hideLabel) return null
  return display.customLabel || fallback
}

/** What assistive tech announces for the field: the custom label, else the default one. */
export const accessibleLabel = (display: { customLabel: string }, fallback: string) => display.customLabel || fallback

/** Sets (or clears, with `null`) one field's display entry, dropping empty parts so the
 * stored JSON stays small and an all-default field disappears from it. */
export function withFieldDisplay(displays: unknown, field: string, next: FieldDisplay | null): FieldDisplays {
  const all = { ...((displays && typeof displays === 'object' ? displays : {}) as FieldDisplays) }
  const clean = next ? compact(next) : null
  if (clean && Object.keys(clean).length > 0) all[field] = clean
  else delete all[field]
  return all
}

function compact(d: FieldDisplay): FieldDisplay {
  const out: FieldDisplay = {}
  if (d.hide_label) out.hide_label = true
  if (d.custom_label?.trim()) out.custom_label = d.custom_label.trim()
  const format = Object.fromEntries(Object.entries(d.format ?? {}).filter(([k, v]) => v !== undefined && v !== '' && !(k === 'as' && v === 'auto')))
  if (Object.keys(format).length) out.format = format as FieldFormat
  if (d.icon?.name) out.icon = d.icon
  return out
}
