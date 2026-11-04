import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js'
import type { FieldFormat, FieldKind } from './field-display'
import { humanize } from './field-display'

// Turns one stored value into what a website shows (ADR-036): text, plus a link for
// the actionable kinds (mail, phone, web). Pure and deterministic — Intl for numbers,
// money and dates, libphonenumber-js for phones — so it gives the same answer on the
// server and in tests, and never touches the stored value: callers keep the raw value,
// this only derives a display string from it.

/** What the formatters need to know about the visitor and the workspace. */
export interface FormatContext {
  /** BCP 47 locale of the visitor's language, e.g. 'fr', 'en-US'. */
  locale: string
  /** The workspace currency: the one money is stored in. */
  currency: string
  /** The visitor's display currency and its rate from the workspace's (1 base = rate), when it differs. */
  convert?: { currency: string; rate: number } | null
  /** Default country of a phone number written without +prefix. */
  country?: string
  /** Default IANA zone for date-times (else the server's). */
  timeZone?: string
  /** Translates UI words (Yes/No, selection values) into the visitor's language. */
  t: (text: string) => string
}

/** Field facts from its declaration that change how it reads (ERP descriptor widget options). */
export interface KindHints {
  /** Percent stored as a ratio (0.25 → 25 %, the ERP default) or as-is (25 → 25 %). */
  percentBase?: 'ratio' | 'percent'
  decimals?: number
  /** Rating: the number of stars. */
  max?: number
}

/** A value ready to draw. */
export interface Presented {
  text: string
  /** mailto:, tel: or an http(s) URL. */
  href?: string
  /** An http(s) link to another site (opens in a new tab). */
  external?: boolean
  /** Keep on one line: amounts, phone numbers, dates must not break apart. */
  nowrap?: boolean
  multiline?: boolean
  /** A color to show as a swatch beside the text. */
  swatch?: string
  /** What assistive tech reads instead of `text` (★★★☆☆ → "3 out of 5"). */
  spoken?: string
  /** The exact value behind an approximation (a converted amount's original). */
  title?: string
}

const toNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const fixed = (decimals: number | undefined) => (typeof decimals === 'number' && decimals >= 0 && decimals <= 6
  ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : {})
const isCurrency = (c: unknown): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c)

/** A locale Intl accepts, else English: a stored tag may be malformed. */
export function safeLocale(locale: string | null | undefined): string {
  try {
    return Intl.getCanonicalLocales(locale || 'en')[0] ?? 'en'
  } catch {
    return 'en'
  }
}

/** The country a locale implies (`fr` → FR, `en` → US, `de-CH` → CH), for phone numbers. */
export function localeCountry(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).maximize().region
  } catch {
    return undefined
  }
}

/** An amount in `currency`, as the locale writes it: symbol side, separators and the
 * currency's own precision (JPY 0, EUR 2, BHD 3) unless `decimals` overrides it. */
export function formatMoney(amount: number, currency: string, locale: string, decimals?: number): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, ...fixed(decimals) }).format(amount)
}

/**
 * A phone number written for reading, and its tel: link. A number of `country` (or
 * written without a prefix) is shown the national way (06 12 34 56 78, (212) 555-1234);
 * any other the international way (+33 6 12 34 56 78). Something that doesn't parse
 * as a possible number is shown exactly as stored — never "corrected" — and only
 * linked when it has enough digits to dial.
 */
export function formatPhone(raw: string, country?: string): Presented | null {
  const text = raw.trim()
  if (!text) return null
  const region = country?.toUpperCase() as CountryCode | undefined
  let parsed: ReturnType<typeof parsePhoneNumberFromString>
  try {
    parsed = parsePhoneNumberFromString(text, region)
  } catch {
    parsed = undefined
  }
  if (!parsed || !parsed.isPossible()) {
    const dial = text.replace(/(?!^\+)[^\d]/g, '')
    return { text, nowrap: true, ...(dial.replace('+', '').length >= 3 && { href: `tel:${dial}` }) }
  }
  const national = !!region && parsed.country === region
  return { text: national ? parsed.formatNational() : parsed.formatInternational(), href: parsed.getURI(), nowrap: true }
}

/** Plain text out of a stored HTML fragment (an `html` field): tags dropped, breaks kept. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim()
}

function dateParts(style: FieldFormat['date_style']): Intl.DateTimeFormatOptions {
  if (style === 'short') return { year: 'numeric', month: '2-digit', day: '2-digit' }
  return { year: 'numeric', month: style === 'long' ? 'long' : 'short', day: 'numeric' }
}

function formatDate(v: unknown, kind: 'date' | 'datetime', f: FieldFormat, ctx: FormatContext): Presented | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const dateOnly = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  const d = new Date(dateOnly ? `${v}T00:00:00Z` : v)
  if (Number.isNaN(d.getTime())) return { text: String(v) }
  // A calendar date has no zone: read it in UTC so it never shifts a day.
  const zone = dateOnly ? 'UTC' : f.timezone || ctx.timeZone
  const opts: Intl.DateTimeFormatOptions = {
    ...dateParts(f.date_style),
    ...(kind === 'datetime' && !dateOnly && { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }),
  }
  const fmt = (timeZone: string | undefined) => new Intl.DateTimeFormat(ctx.locale, { ...opts, timeZone }).format(d)
  let text: string
  try {
    text = fmt(zone)
  } catch {
    text = fmt(ctx.timeZone) // an unknown zone typed in the settings: the default one
  }
  return { text, nowrap: kind === 'date' }
}

/**
 * One field's value as the website shows it, or null when there is nothing to show
 * (empty, or a structured value with no one-line form). `kind` is the field's resolved
 * kind (field-meta.ts), `f` its display format, `record` the row (for a currency column).
 */
export function presentValue(value: unknown, kind: FieldKind, f: FieldFormat, ctx: FormatContext, hints: KindHints = {}, record: Record<string, unknown> = {}): Presented | null {
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') return value == null ? null : { text: String(value) }
    return { text: value ? f.true_label || ctx.t('Yes') : f.false_label || ctx.t('No') }
  }
  if (value == null || value === '' || typeof value === 'object') return null
  const str = String(value)
  switch (kind) {
    case 'multiline': {
      const text = /<[a-z][\s\S]*>/i.test(str) ? htmlToText(str) : str
      return text ? { text, multiline: true } : null
    }
    case 'email': {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)
      return { text: str, ...(ok && { href: `mailto:${str}` }) }
    }
    case 'url': {
      const href = /^https?:\/\//i.test(str) ? str : /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(str) ? `https://${str}` : null
      if (!href) return { text: str }
      // Shown without the scheme and trailing slash: what a visitor would type.
      return { text: href.replace(/^https?:\/\//i, '').replace(/\/$/, ''), href, external: true }
    }
    case 'phone':
      return formatPhone(str, f.country || ctx.country)
    case 'monetary': {
      const n = toNumber(value)
      if (n === null) return { text: str }
      const fromRecord = f.currency_field ? record[f.currency_field] : undefined
      const currency = isCurrency(f.currency) ? f.currency : isCurrency(fromRecord) ? fromRecord : ctx.currency
      if (!isCurrency(currency)) return { text: new Intl.NumberFormat(ctx.locale, fixed(f.decimals ?? 2)).format(n), nowrap: true }
      const exact = formatMoney(n, currency, ctx.locale, f.decimals)
      // The visitor's currency (ADR-034): a display-only conversion, marked ≈, the
      // stored amount in the tooltip. Only from the workspace currency, the one rates exist for.
      if (ctx.convert && currency === ctx.currency && ctx.convert.currency !== currency) {
        return { text: `≈ ${formatMoney(n * ctx.convert.rate, ctx.convert.currency, ctx.locale, f.decimals)}`, title: exact, nowrap: true }
      }
      return { text: exact, nowrap: true }
    }
    case 'integer':
    case 'decimal': {
      const n = toNumber(value)
      if (n === null) return { text: str }
      const decimals = f.decimals ?? hints.decimals
      const opts = kind === 'integer' ? { maximumFractionDigits: 0 } : typeof decimals === 'number' ? fixed(decimals) : { maximumFractionDigits: 2 }
      return { text: new Intl.NumberFormat(ctx.locale, opts).format(n), nowrap: true }
    }
    case 'percent': {
      const n = toNumber(value)
      if (n === null) return { text: str }
      const ratio = hints.percentBase === 'percent' ? n / 100 : n
      const decimals = f.decimals ?? hints.decimals
      return { text: new Intl.NumberFormat(ctx.locale, { style: 'percent', ...(typeof decimals === 'number' ? fixed(decimals) : { maximumFractionDigits: 2 }) }).format(ratio), nowrap: true }
    }
    case 'rating': {
      const n = toNumber(value)
      if (n === null) return { text: str }
      const max = Math.min(Math.max(Math.round(hints.max ?? 5), 1), 10)
      const on = Math.min(Math.max(Math.round(n), 0), max)
      return { text: '★'.repeat(on) + '☆'.repeat(max - on), spoken: ctx.t('{n} out of {max}').replace('{n}', String(on)).replace('{max}', String(max)), nowrap: true }
    }
    case 'duration': {
      const n = toNumber(value)
      if (n === null) return { text: str }
      const h = Math.floor(Math.abs(n) / 60)
      const m = Math.round(Math.abs(n) % 60)
      const unit = (amount: number, u: 'hour' | 'minute') => new Intl.NumberFormat(ctx.locale, { style: 'unit', unit: u, unitDisplay: 'short' }).format(amount)
      const parts = [h ? unit(h, 'hour') : '', m || !h ? unit(m, 'minute') : ''].filter(Boolean)
      return { text: (n < 0 ? '−' : '') + parts.join(' '), nowrap: true }
    }
    case 'date':
    case 'datetime':
      return formatDate(value, kind, f, ctx)
    case 'selection': {
      const translated = ctx.t(str)
      return { text: translated !== str ? translated : humanize(str) }
    }
    case 'color':
      return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(str) ? { text: str.toUpperCase(), swatch: str } : { text: str }
    case 'relation':
    case 'text':
    default:
      return { text: str }
  }
}
