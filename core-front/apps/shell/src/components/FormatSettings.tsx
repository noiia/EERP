'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Container from '@mui/material/Container'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { formatNumber, useFormatStore, useT } from '@eerp/core-front'
import { setWorkspaceNumberFormat } from '@/lib/preferences'

// Settings → Formats: how numbers display across the whole workspace. The durable
// value is server state (app_settings key format.number, PUT /settings/format,
// permission settings:format:write — Go re-authorizes every write); useFormatStore
// is its client mirror, updated optimistically here and reconciled by LocaleSync on
// the next load. Every numeric widget renders through useNumberFormat(), so a change
// here reformats the entire app instantly.

/** Sentinel for the "no grouping" thousands choice ('' can't be a Select value). */
const NONE_VALUE = 'none'

const DECIMAL_CHOICES = [
  { value: '.', label: 'Period' },
  { value: ',', label: 'Comma' },
] as const

const THOUSANDS_CHOICES = [
  { value: NONE_VALUE, label: 'None' },
  { value: ' ', label: 'Space' },
  { value: ',', label: 'Comma' },
  { value: '.', label: 'Period' },
  { value: "'", label: 'Apostrophe' },
] as const

export default function FormatSettings({ canEdit }: { canEdit: boolean }) {
  const t = useT()
  const decimalSeparator = useFormatStore((s) => s.decimalSeparator)
  const thousandsSeparator = useFormatStore((s) => s.thousandsSeparator)
  const setNumberFormat = useFormatStore((s) => s.setNumberFormat)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const config = { decimalSeparator, thousandsSeparator }

  async function onChange(next: { decimalSeparator: string; thousandsSeparator: string }) {
    if (next.decimalSeparator === next.thousandsSeparator) {
      setError(t('The decimal and thousands separators must differ.'))
      return
    }
    const previous = config
    setError(null)
    setNumberFormat(next) // optimistic: the whole app reformats immediately
    setSaving(true)
    const result = await setWorkspaceNumberFormat({
      decimal_separator: next.decimalSeparator,
      thousands_separator: next.thousandsSeparator,
    })
    setSaving(false)
    if (!result.ok) {
      setNumberFormat(previous)
      setError(result.message)
    }
  }

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h4" component="h1">
            {t('Formats')}
          </Typography>
          <Typography color="text.secondary">
            {t('How numbers display across the workspace, for everyone.')}
          </Typography>
        </Stack>

        <Stack direction="row" spacing={2}>
          <FormControl sx={{ minWidth: 200 }} disabled={!canEdit || saving}>
            <InputLabel id="decimal-separator-label">{t('Decimal separator')}</InputLabel>
            <Select
              labelId="decimal-separator-label"
              label={t('Decimal separator')}
              value={decimalSeparator}
              onChange={(e) => void onChange({ ...config, decimalSeparator: e.target.value })}
            >
              {DECIMAL_CHOICES.map((choice) => (
                <MenuItem key={choice.value} value={choice.value}>
                  {t(choice.label)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl sx={{ minWidth: 200 }} disabled={!canEdit || saving}>
            <InputLabel id="thousands-separator-label">{t('Thousands separator')}</InputLabel>
            <Select
              labelId="thousands-separator-label"
              label={t('Thousands separator')}
              value={thousandsSeparator === '' ? NONE_VALUE : thousandsSeparator}
              onChange={(e) =>
                void onChange({
                  ...config,
                  thousandsSeparator: e.target.value === NONE_VALUE ? '' : e.target.value,
                })
              }
            >
              {THOUSANDS_CHOICES.map((choice) => (
                <MenuItem key={choice.value} value={choice.value}>
                  {t(choice.label)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>

        {/* Live preview so the choice is legible before any number is on screen. */}
        <Typography data-testid="format-preview" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {t('Preview:')} {formatNumber(1234567.89, config, { decimals: 2 })}
        </Typography>

        {!canEdit && (
          <Typography variant="body2" color="text.secondary">
            {t('Changing the workspace number format requires the settings:format:write permission.')}
          </Typography>
        )}
        {error && <Alert severity="error">{error}</Alert>}
      </Stack>
    </Container>
  )
}
