'use client'
import { useEffect, useRef, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import { addressSubKey, ADDRESS_SUFFIXES, fieldLabel } from './descriptor'
import type { WidgetProps } from './widgets'

// type: 'address' / widget: 'form' — a composite field over 7 real sibling
// columns (see descriptor.ts's FIELD_WIDGETS doc comment for the full
// contract): field.name is a PREFIX, never a column of its own. Reads the
// current values off WidgetProps.draft (A1 — layout-renderer.tsx threads the
// whole draft down for exactly this case) and writes through the existing
// onChangeField (the same sibling-write mechanism SelectionLinkedWidget
// already uses in widgets.tsx) — no new plumbing beyond A1.
//
// "Number and street" is ONE combined text input ("12 Main Street") even
// though it's stored as two separate columns (number: int, street: string)
// — parsed on every change: leading digits become the number, the remainder
// the street. Reconstructed from the two stored values whenever the field
// ISN'T being actively edited, so a value typed elsewhere (e.g. picking an
// OSM autocomplete suggestion) still displays correctly.
//
// Autocomplete: typing into "Number and street" debounce-queries the BFF's
// /api/integrations/osm/search proxy (Settings -> Global settings ->
// Integrations owns the actual connector config server-side — this widget
// never talks to Nominatim directly, or even knows whether a connector is
// configured). Disabled/unconfigured/upstream-down all resolve to an empty
// suggestion list, so the field degrades to plain manual entry with no
// special-casing here — same "render inert, not a crash" posture every
// other optional Ops/connector integration in this codebase already takes.

function asText(value: unknown): string {
  return value == null ? '' : String(value)
}

/** "12" + "Main Street" -> {number: 12, street: "Main Street"}; leading digits
 * become the number, anything else (or nothing) leaves it null. */
function parseStreetLine(raw: string): { number: number | null; street: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { number: null, street: '' }
  const match = /^(\d+)\s*(.*)$/.exec(trimmed)
  if (match) return { number: Number(match[1]), street: match[2] }
  return { number: null, street: trimmed }
}

/** One normalized suggestion from the OSM search BFF route — mirrors
 * apps/shell's OSMSuggestion shape exactly (kept independent here: the
 * engine package doesn't depend on the shell app). */
interface OSMSuggestion {
  label: string
  number: number | null
  street: string
  complement: string
  zip_code: string
  city: string
  state: string
  country: string
}

const OSM_SEARCH_DEBOUNCE_MS = 300
/** Below this length Nominatim-style geocoders return noisy/irrelevant
 * results anyway — skip the round trip entirely. */
const OSM_MIN_QUERY_LENGTH = 3

/** Debounced address search against the BFF proxy — never Nominatim
 * directly (see the file-level doc comment). */
function useOSMSuggestions() {
  const [options, setOptions] = useState<OSMSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const search = (query: string) => {
    if (timer.current) clearTimeout(timer.current)
    if (query.trim().length < OSM_MIN_QUERY_LENGTH) {
      setOptions([])
      return
    }
    timer.current = setTimeout(() => {
      setLoading(true)
      fetch(`/api/integrations/osm/search?q=${encodeURIComponent(query)}`)
        .then((res) => (res.ok ? (res.json() as Promise<{ results: OSMSuggestion[] }>) : { results: [] }))
        .then((body) => setOptions(body.results ?? []))
        .catch(() => setOptions([]))
        .finally(() => setLoading(false))
    }, OSM_SEARCH_DEBOUNCE_MS)
  }

  return { options, loading, search }
}

export function AddressWidget({ field, draft, onChangeField, disabled }: WidgetProps) {
  const t = useT()
  const prefix = field.name
  const values = draft ?? {}
  const number = values[addressSubKey(prefix, 'number')]
  const street = values[addressSubKey(prefix, 'street')]
  const complement = values[addressSubKey(prefix, 'complement')]
  const zipCode = values[addressSubKey(prefix, 'zip_code')]
  const city = values[addressSubKey(prefix, 'city')]
  const state = values[addressSubKey(prefix, 'state')]
  const country = values[addressSubKey(prefix, 'country')]

  const [editingStreetLine, setEditingStreetLine] = useState<string | null>(null)
  const storedStreetLine = [asText(number), asText(street)].filter((s) => s !== '').join(' ')
  const streetLineValue = editingStreetLine ?? storedStreetLine
  const osm = useOSMSuggestions()

  const commitStreetLine = () => {
    if (editingStreetLine == null) return
    const { number: parsedNumber, street: parsedStreet } = parseStreetLine(editingStreetLine)
    onChangeField?.(addressSubKey(prefix, 'number'), parsedNumber)
    onChangeField?.(addressSubKey(prefix, 'street'), parsedStreet)
    setEditingStreetLine(null)
  }

  /** Picking a suggestion fills ALL 7 sibling columns at once — not just
   * number/street — then closes out the in-progress edit. */
  const applySuggestion = (suggestion: OSMSuggestion) => {
    onChangeField?.(addressSubKey(prefix, 'number'), suggestion.number)
    onChangeField?.(addressSubKey(prefix, 'street'), suggestion.street)
    onChangeField?.(addressSubKey(prefix, 'complement'), suggestion.complement)
    onChangeField?.(addressSubKey(prefix, 'zip_code'), suggestion.zip_code)
    onChangeField?.(addressSubKey(prefix, 'city'), suggestion.city)
    onChangeField?.(addressSubKey(prefix, 'state'), suggestion.state)
    onChangeField?.(addressSubKey(prefix, 'country'), suggestion.country)
    setEditingStreetLine(null)
  }

  const sub = (suffix: (typeof ADDRESS_SUFFIXES)[number], value: unknown, label: string) => (
    <TextField
      label={t(label)}
      fullWidth
      size="small"
      disabled={disabled}
      value={asText(value)}
      onChange={(e) => onChangeField?.(addressSubKey(prefix, suffix), e.target.value)}
    />
  )

  return (
    <Stack spacing={1.5}>
      {!field.hideLabel && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {t(fieldLabel(field))}
        </Typography>
      )}
      <Autocomplete
        freeSolo
        disabled={disabled}
        options={osm.options}
        loading={osm.loading}
        // Results already come pre-filtered from the search endpoint — don't
        // ALSO client-filter by substring match against the raw query.
        filterOptions={(options) => options}
        getOptionLabel={(option) => (typeof option === 'string' ? option : option.label)}
        inputValue={streetLineValue}
        onInputChange={(_event, newValue, reason) => {
          if (reason !== 'input') return
          setEditingStreetLine(newValue)
          osm.search(newValue)
        }}
        onChange={(_event, value) => {
          if (value && typeof value !== 'string') applySuggestion(value)
        }}
        onBlur={commitStreetLine}
        renderInput={(params) => (
          <TextField
            {...params}
            label={t('Number and street')}
            size="small"
            slotProps={{
              ...params.slotProps,
              input: {
                ...params.slotProps.input,
                endAdornment: (
                  <>
                    {osm.loading && <CircularProgress color="inherit" size={16} />}
                    {params.slotProps.input.endAdornment}
                  </>
                ),
              },
            }}
          />
        )}
      />
      {sub('complement', complement, 'Complement')}
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 1.5 }}>
        {sub('zip_code', zipCode, 'Zip code')}
        {sub('city', city, 'City')}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
        {sub('state', state, 'State')}
        {sub('country', country, 'Country')}
      </Box>
    </Stack>
  )
}
