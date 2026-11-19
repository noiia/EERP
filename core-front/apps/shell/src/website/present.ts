import 'server-only'
import { translate } from '@eerp/core-front'
import { accessibleLabel, humanize, resolveDisplay, visibleLabel, type ResolvedIcon } from './field-display'
import { localeCountry, presentValue, safeLocale, type FormatContext, type Presented } from './field-format'
import { resolveIcon, type SiteIconData } from './field-icons'
import { fieldMetas } from './field-meta'
import { getSitePreferences } from './site-preferences'
import type { PublicDataSource } from './types'

// The website's field rendering pipeline (ADR-036), server side:
//
//   records (public API) ─► field-meta (what each column holds)
//                       ─► field-display (the block's label/format/icon settings)
//                       ─► field-format (value → text + link)
//                       ─► PresentedFields ─► FieldValue.tsx draws it (server or client)
//
// Everything is resolved here, once per block render, into plain JSON: client
// components (the record list's grid/table toggle) receive strings, never a formatter,
// a phone-number library or an icon set.

/** One shown field, the same for every row: its label, accessible name and icon. */
export interface FieldColumn {
  name: string
  /** The visible label; null when hidden. */
  label: string | null
  /** Always set: what assistive tech reads before the value, even when the label is hidden. */
  spoken: string
  icon: (ResolvedIcon & { data: SiteIconData }) | null
}

export interface PresentedFields {
  columns: FieldColumn[]
  /** Per record id, per column: the value to draw, or null (nothing to show). */
  values: Record<string, Record<string, Presented | null>>
}

/** The visitor's formatting context: their language and display currency, the
 * workspace's currency and default phone country. Never fails: a site whose
 * localization can't be read formats in English. */
export async function siteFormatContext(): Promise<FormatContext> {
  const site = await getSitePreferences().catch(() => null)
  // A null locale is the source language (English), what the page's text is shown in.
  const locale = safeLocale(site?.prefs.locale ?? 'en')
  const t = (text: string) => translate(site?.prefs.locale ?? null, text)
  if (!site) return { locale, currency: '', t }
  const { base, rates, default_locale } = site.localization
  const visitor = site.prefs.currency
  return {
    locale,
    currency: base,
    convert: visitor && visitor !== base && rates[visitor] ? { currency: visitor, rate: rates[visitor] } : null,
    // A number without +prefix is the business's own country's: the site's default language's.
    country: localeCountry(safeLocale(default_locale)),
    t,
  }
}

/** A many2one's label per id, read through the public API (an unpublished target shows nothing). */
async function relationLabels(source: PublicDataSource, table: string, labelField: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].slice(0, 50)
  const rows = await Promise.all(unique.map((id) => source.get(table, id).catch(() => null)))
  return new Map(unique.flatMap((id, i) => {
    const label = rows[i]?.[labelField]
    return typeof label === 'string' || typeof label === 'number' ? [[id, String(label)] as const] : []
  }))
}

/**
 * The rows' fields as the site shows them. `fields` in their configured order;
 * `skip` (the title field, drawn as a heading) left out; `displays` the block's
 * per-field settings (absent = defaults).
 */
export async function presentFields(opts: {
  table: string
  fields: string[]
  records: Record<string, unknown>[]
  displays?: unknown
  skip?: string
  source: PublicDataSource
  ctx?: FormatContext
}): Promise<PresentedFields> {
  const ctx = opts.ctx ?? await siteFormatContext()
  const names = opts.fields.filter((f) => f !== opts.skip)
  const metas = fieldMetas(opts.table, names, opts.records[0])
  const columns: FieldColumn[] = names.map((name) => {
    const display = resolveDisplay(opts.displays, name)
    // The column name, as sites have always shown it: a module's label is written for
    // staff ("Price override (excl. tax)"), not visitors. A custom label replaces it.
    const fallback = humanize(name)
    const data = display.icon ? resolveIcon(display.icon.family, display.icon.name) : undefined
    return {
      name,
      label: visibleLabel(display, fallback),
      spoken: accessibleLabel(display, fallback),
      icon: display.icon && data ? { ...display.icon, data } : null,
    }
  })
  // Linked records' labels, one lookup per distinct id.
  const labels = new Map<string, Map<string, string>>()
  await Promise.all(names.map(async (name) => {
    const rel = metas[name].relation
    const kind = resolveDisplay(opts.displays, name).format.as
    if (!rel || (kind && kind !== 'auto' && kind !== 'relation')) return
    const ids = opts.records.map((r) => r[name]).filter((v): v is string => typeof v === 'string' && v !== '')
    if (ids.length) labels.set(name, await relationLabels(opts.source, rel.table, rel.labelField, ids))
  }))
  const values: PresentedFields['values'] = {}
  for (const rec of opts.records) {
    const row: Record<string, Presented | null> = {}
    for (const name of names) {
      const { format } = resolveDisplay(opts.displays, name)
      const kind = format.as && format.as !== 'auto' ? format.as : metas[name].kind
      let value = rec[name]
      if (kind === 'relation') {
        // A linked record is shown by its label, never its raw id.
        value = typeof value === 'string' ? labels.get(name)?.get(value) ?? null : null
      }
      row[name] = presentValue(value, kind, format, ctx, metas[name].hints, rec)
    }
    values[String(rec.id)] = row
  }
  return { columns, values }
}
