'use client'
import { useState, type ComponentType } from 'react'
import Box from '@mui/material/Box'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputAdornment from '@mui/material/InputAdornment'
import MenuItem from '@mui/material/MenuItem'
import Rating from '@mui/material/Rating'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import { fieldLabel, resolveWidget, type FieldDescriptor, type JsonValue } from './descriptor'
import { BooleanPictureWidget, BooleanSignatureWidget } from './picture-widgets'
import { RelationListWidget, RelationSearchWidget, RelationTagsWidget } from './relation-widgets'
import { useNumberFormat } from './format-store'
import { tabularNums } from './tokens'

// The widget layer: one component per (type, widget) pair of the FIELD_WIDGETS
// matrix. Engine-internal — modules select widgets DECLARATIVELY on their field
// descriptors; nothing here is part of the module ABI. The form renderer
// dispatches through fieldWidget(); numeric widgets format exclusively through
// useNumberFormat(), so the workspace separators apply app-wide with zero widget
// code change (docs/roadmaps/field-widgets.md, Phase 1).

export interface WidgetProps {
  field: FieldDescriptor
  value: unknown
  onChange: (value: unknown) => void
  /** Render inert (computed fields — the engine owns their value). */
  disabled?: boolean
  /**
   * Anchor context for service-backed widgets (picture/signature): the Go
   * entity (= table) and the record's id. `recordId` is null until the record
   * first saves — those widgets render a hint instead of an upload surface.
   * Plain value widgets ignore both.
   */
  entity?: string
  recordId?: string | null
}

// ── text ──────────────────────────────────────────────────────────────────────

function TextSimpleWidget({ field, value, onChange, disabled }: WidgetProps) {
  const t = useT()
  return (
    <TextField
      label={field.hideLabel ? undefined : t(fieldLabel(field))}
      required={field.required}
      disabled={disabled}
      fullWidth
      value={(value as string) ?? ''}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function TextLongWidget({ field, value, onChange, disabled }: WidgetProps) {
  const t = useT()
  return (
    <TextField
      label={field.hideLabel ? undefined : t(fieldLabel(field))}
      required={field.required}
      disabled={disabled}
      fullWidth
      multiline
      minRows={4}
      value={(value as string) ?? ''}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

// ── table (docs/roadmaps/app-store.md, Phase 2) ───────────────────────────────

/** widgetOptions.columns entry — declared, not inferred, like every other
 * descriptor-driven presentation choice. */
export interface TableWidgetColumn {
  key: string
  label: string
}

/**
 * A generic read-only table: `value` is an array of plain records, rendered
 * one row per entry against DECLARED columns (widgetOptions.columns) — never
 * inferred from the data, so column order/labels are a descriptor concern
 * like everywhere else. Not "the App Store's Views widget": any future field
 * whose value is naturally a small list of records (too small to need
 * pagination) reuses this. Always effectively read-only — no onChange is
 * ever wired, not just a disabled affordance — because there is no editing
 * surface here at all, just cells. A missing key on a given row reads as an
 * empty cell rather than throwing (loosely-typed data, not a validated one).
 */
function TableWidget({ field, value }: WidgetProps) {
  const t = useT()
  const columns = Array.isArray(field.widgetOptions?.columns)
    ? (field.widgetOptions.columns as unknown as TableWidgetColumn[])
    : []
  const rows = Array.isArray(value) ? (value as Record<string, JsonValue>[]) : []
  // A declared emptyLabel is a msgid too (like col.label/fieldLabel) — always
  // t()'d, never rendered raw.
  const emptyLabel =
    typeof field.widgetOptions?.emptyLabel === 'string'
      ? field.widgetOptions.emptyLabel
      : 'Nothing here yet.'

  return (
    <Box>
      {!field.hideLabel && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {t(fieldLabel(field))}
        </Typography>
      )}
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t(emptyLabel)}
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              {columns.map((col) => (
                <TableCell key={col.key}>{t(col.label)}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, i) => (
              // Rows are anonymous records with no natural id, and this table
              // never reorders — index-as-key is safe here.
              <TableRow key={i}>
                {columns.map((col) => {
                  const cell = row[col.key]
                  return <TableCell key={col.key}>{cell != null ? String(cell) : ''}</TableCell>
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  )
}

// ── selection ─────────────────────────────────────────────────────────────────

/**
 * A closed-list dropdown (Odoo's Selection field, transposed). Options are
 * declared data (field.selection.options), never hardcoded here — the widget
 * only renders the list the descriptor gives it. Each option's DISPLAY goes
 * through t() (a msgid, like a field label); the stored/onChange value stays
 * the raw option string, untranslated — the same "source string = value"
 * split as everywhere else in the engine.
 */
function SelectionWidget({ field, value, onChange, disabled }: WidgetProps) {
  const t = useT()
  const options = field.selection?.options ?? []
  return (
    <TextField
      select
      label={field.hideLabel ? undefined : t(fieldLabel(field))}
      required={field.required}
      disabled={disabled}
      fullWidth
      value={typeof value === 'string' && options.includes(value) ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <MenuItem key={option} value={option}>
          {t(option)}
        </MenuItem>
      ))}
    </TextField>
  )
}

// ── date (stock input moved out of the renderer) ──────────────────────────────

function DateWidget({ field, value, onChange, disabled }: WidgetProps) {
  const t = useT()
  // A native date input's value MUST be exactly 'YYYY-MM-DD' or the browser
  // silently renders it blank. A real Go `time.Time` column round-trips as a
  // full RFC3339 timestamp ("2026-07-10T00:00:00Z"), not a bare date — strip
  // any time/zone suffix rather than passing it straight through.
  const raw = typeof value === 'string' ? value : ''
  const dateOnly = /^\d{4}-\d{2}-\d{2}/.exec(raw)?.[0] ?? ''
  return (
    <TextField
      label={field.hideLabel ? undefined : t(fieldLabel(field))}
      type="date"
      required={field.required}
      disabled={disabled}
      fullWidth
      slotProps={{ inputLabel: { shrink: true } }}
      value={dateOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

// ── boolean ───────────────────────────────────────────────────────────────────

function BooleanSwitchWidget({ field, value, onChange, disabled }: WidgetProps) {
  const t = useT()
  return (
    <FormControlLabel
      control={<Switch checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />}
      label={field.hideLabel ? '' : t(fieldLabel(field))}
      disabled={disabled}
    />
  )
}

// ── number ────────────────────────────────────────────────────────────────────

/**
 * Shared editing behavior for formatted numeric inputs: the field shows the
 * FORMATTED value (workspace separators) while idle and switches to a raw
 * editable string while focused; every parseable keystroke commits to the
 * draft, blur reformats. `scale` maps between the stored and displayed value
 * (percent stores a ratio, displays ×100).
 */
function useNumericInput({
  value,
  onChange,
  decimals,
  scale = 1,
  integer = false,
}: {
  value: unknown
  onChange: (value: unknown) => void
  decimals?: number
  scale?: number
  integer?: boolean
}) {
  const { format, parse, decimalSeparator } = useNumberFormat()
  const [editing, setEditing] = useState<string | null>(null)

  const stored = typeof value === 'number' && Number.isFinite(value) ? value : null
  const displayed = stored != null ? stored * scale : null
  const text = editing ?? (displayed != null ? format(displayed, { decimals }) : '')

  return {
    text,
    onFocus: () =>
      setEditing(displayed != null ? String(displayed).replace('.', decimalSeparator) : ''),
    onBlur: () => setEditing(null),
    onInput: (raw: string) => {
      setEditing(raw)
      if (raw.trim() === '') {
        onChange(null)
        return
      }
      const parsed = parse(raw)
      if (Number.isNaN(parsed)) return
      const scaled = parsed / scale
      onChange(integer ? Math.round(scaled) : scaled)
    },
  }
}

function NumberInput({
  field,
  input,
  endAdornment,
  disabled,
}: {
  field: FieldDescriptor
  input: ReturnType<typeof useNumericInput>
  endAdornment?: string
  disabled?: boolean
}) {
  const t = useT()
  return (
    <TextField
      label={field.hideLabel ? undefined : t(fieldLabel(field))}
      required={field.required}
      disabled={disabled}
      fullWidth
      value={input.text}
      onFocus={input.onFocus}
      onBlur={input.onBlur}
      onChange={(e) => input.onInput(e.target.value)}
      slotProps={{
        input: {
          endAdornment: endAdornment ? (
            <InputAdornment position="end">{endAdornment}</InputAdornment>
          ) : undefined,
        },
        htmlInput: { inputMode: 'decimal' },
      }}
      sx={{ '& input': { fontVariantNumeric: tabularNums } }}
    />
  )
}

function NumberFloatWidget({ field, value, onChange, disabled }: WidgetProps) {
  const decimals = typeof field.widgetOptions?.decimals === 'number' ? field.widgetOptions.decimals : 2
  const input = useNumericInput({ value, onChange, decimals })
  return <NumberInput field={field} input={input} disabled={disabled} />
}

function NumberIntWidget({ field, value, onChange, disabled }: WidgetProps) {
  const input = useNumericInput({ value, onChange, decimals: 0, integer: true })
  return <NumberInput field={field} input={input} disabled={disabled} />
}

function NumberPercentWidget({ field, value, onChange, disabled }: WidgetProps) {
  // base 'ratio' (default): 0.25 stored, "25 %" shown. base 'percent': stored as-is.
  const scale = field.widgetOptions?.base === 'percent' ? 1 : 100
  const decimals = typeof field.widgetOptions?.decimals === 'number' ? field.widgetOptions.decimals : 2
  const input = useNumericInput({ value, onChange, decimals, scale })
  return <NumberInput field={field} input={input} endAdornment="%" disabled={disabled} />
}

function NumberStarsWidget({ field, value, onChange, disabled }: WidgetProps) {
  const t = useT()
  const max = typeof field.widgetOptions?.max === 'number' ? field.widgetOptions.max : 3
  return (
    <Box>
      {!field.hideLabel && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {t(fieldLabel(field))}
        </Typography>
      )}
      <Rating
        max={max}
        precision={0.5}
        readOnly={disabled}
        value={typeof value === 'number' ? value : 0}
        onChange={(_e, next) => onChange(next ?? 0)}
      />
    </Box>
  )
}

// ── phone (allowed on text — recommended — and number) ────────────────────────

/**
 * The country indicator's dial-code table. Deliberately compact: dev-facing
 * defaults, not a libphonenumber replacement. Ordered longest-dial-first when
 * matching so '+1 ...' never shadows '+1242'-style codes we may add later.
 */
export const PHONE_COUNTRIES: readonly { code: string; dial: string; flag: string }[] = [
  { code: 'FR', dial: '33', flag: '🇫🇷' },
  { code: 'BE', dial: '32', flag: '🇧🇪' },
  { code: 'CH', dial: '41', flag: '🇨🇭' },
  { code: 'DE', dial: '49', flag: '🇩🇪' },
  { code: 'ES', dial: '34', flag: '🇪🇸' },
  { code: 'IT', dial: '39', flag: '🇮🇹' },
  { code: 'PT', dial: '351', flag: '🇵🇹' },
  { code: 'NL', dial: '31', flag: '🇳🇱' },
  { code: 'GB', dial: '44', flag: '🇬🇧' },
  { code: 'IE', dial: '353', flag: '🇮🇪' },
  { code: 'US', dial: '1', flag: '🇺🇸' },
  { code: 'CA', dial: '1', flag: '🇨🇦' },
  { code: 'BR', dial: '55', flag: '🇧🇷' },
  { code: 'MA', dial: '212', flag: '🇲🇦' },
  { code: 'DZ', dial: '213', flag: '🇩🇿' },
  { code: 'TN', dial: '216', flag: '🇹🇳' },
  { code: 'SN', dial: '221', flag: '🇸🇳' },
  { code: 'CI', dial: '225', flag: '🇨🇮' },
  { code: 'JP', dial: '81', flag: '🇯🇵' },
  { code: 'CN', dial: '86', flag: '🇨🇳' },
  { code: 'IN', dial: '91', flag: '🇮🇳' },
  { code: 'AU', dial: '61', flag: '🇦🇺' },
]

/** Split a stored phone value into the matched country + national digits. */
function splitPhone(value: unknown): { country: (typeof PHONE_COUNTRIES)[number] | null; national: string } {
  const digits = String(value ?? '')
    .replace(/^\+/, '')
    .replace(/\D/g, '')
  if (!digits) return { country: null, national: '' }
  const match = [...PHONE_COUNTRIES]
    .sort((a, b) => b.dial.length - a.dial.length)
    .find((c) => digits.startsWith(c.dial))
  return match
    ? { country: match, national: digits.slice(match.dial.length) }
    : { country: null, national: digits }
}

function PhoneWidget({ field, value, onChange, disabled }: WidgetProps) {
  const t = useT()
  const defaultCode =
    typeof field.widgetOptions?.defaultCountry === 'string' ? field.widgetOptions.defaultCountry : 'FR'
  const parsed = splitPhone(value)
  // The picked country only needs local state while the number is still empty;
  // once digits exist the stored E.164 value is the single source of truth.
  const [pickedCode, setPickedCode] = useState(defaultCode)
  const country =
    parsed.country ?? PHONE_COUNTRIES.find((c) => c.code === pickedCode) ?? PHONE_COUNTRIES[0]

  const commit = (dial: string, national: string) => {
    const digits = national.replace(/\D/g, '')
    if (!digits) {
      onChange(null)
      return
    }
    // text columns get E.164 ('+33612…'); numeric columns can't hold the '+'
    // (nor leading zeros — the roadmap documents why text is recommended).
    onChange(field.type === 'number' ? Number(`${dial}${digits}`) : `+${dial}${digits}`)
  }

  return (
    <Box sx={{ display: 'flex', gap: 1 }}>
      <TextField
        select
        aria-label={t('Country')}
        disabled={disabled}
        value={country.code}
        onChange={(e) => {
          setPickedCode(e.target.value)
          const next = PHONE_COUNTRIES.find((c) => c.code === e.target.value)
          if (next && parsed.national) commit(next.dial, parsed.national)
        }}
        sx={{ minWidth: 110 }}
      >
        {PHONE_COUNTRIES.map((c) => (
          <MenuItem key={c.code} value={c.code}>
            {c.flag} +{c.dial}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label={field.hideLabel ? undefined : t(fieldLabel(field))}
        required={field.required}
        disabled={disabled}
        fullWidth
        value={parsed.national}
        onChange={(e) => commit(country.dial, e.target.value)}
        slotProps={{ htmlInput: { inputMode: 'tel' } }}
        sx={{ '& input': { fontVariantNumeric: tabularNums } }}
      />
    </Box>
  )
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const WIDGET_COMPONENTS: Record<string, ComponentType<WidgetProps>> = {
  'text/simple': TextSimpleWidget,
  'text/long': TextLongWidget,
  'text/phone': PhoneWidget,
  'text/table': TableWidget,
  'number/float': NumberFloatWidget,
  'number/int': NumberIntWidget,
  'number/percent': NumberPercentWidget,
  'number/stars': NumberStarsWidget,
  'number/phone': PhoneWidget,
  'boolean/switch': BooleanSwitchWidget,
  'boolean/picture': BooleanPictureWidget,
  'boolean/signature': BooleanSignatureWidget,
  'date/simple': DateWidget,
  'selection/select': SelectionWidget,
  'relation/search': RelationSearchWidget,
  'relation/tags': RelationTagsWidget,
  'relation/list': RelationListWidget,
}

/**
 * Resolve a field to its widget component. resolveWidget() already enforces the
 * matrix (and registration validated it), so a miss here is an engine bug — a
 * matrix entry without a component — and throws accordingly.
 */
export function fieldWidget(field: FieldDescriptor): ComponentType<WidgetProps> {
  const widget = resolveWidget(field)
  const component = WIDGET_COMPONENTS[`${field.type}/${widget}`]
  if (!component) {
    throw new Error(`engine bug: no component for widget "${field.type}/${widget}"`)
  }
  return component
}
