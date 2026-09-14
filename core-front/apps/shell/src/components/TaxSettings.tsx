'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { setTaxSettings, type TaxPriceMode, type TaxSettings } from '@/lib/tax-settings'

// Settings -> Global settings -> Tax: the workspace-wide switch deciding
// whether a sale_line/billing_line's price already has its taxes baked in
// (tax_included, e.g. "12€ including 20% tax" stays 12€) or has tax computed
// on top of it (tax_excluded, the default — "12€ + 20% tax" becomes
// 14.40€). Applies uniformly to both SaleTax kinds (percentage and fixed).
// Same save-on-change shape as OSMConnectorSettings; a single radio choice
// needs no separate Save button.
export default function TaxSettings({
  canEdit,
  initialSettings,
}: {
  canEdit: boolean
  initialSettings: TaxSettings
}) {
  const t = useT()
  const [priceMode, setPriceMode] = useState<TaxPriceMode>(initialSettings.price_mode)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: TaxPriceMode) {
    setError(null)
    setSaving(true)
    const result = await setTaxSettings({ price_mode: next })
    setSaving(false)
    if (!result.ok) setError(result.message)
  }

  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        {t(
          'Decides how a line’s tax is computed: whether the price already includes tax, or tax is added on top of it. Applies workspace-wide, to every percentage and fixed tax.',
        )}
      </Typography>

      <FormControl disabled={!canEdit || saving}>
        <RadioGroup
          value={priceMode}
          onChange={(e) => {
            const next = e.target.value as TaxPriceMode
            setPriceMode(next)
            void save(next)
          }}
        >
          <FormControlLabel
            value="tax_excluded"
            control={<Radio />}
            label={t('Tax computed on top of the price (e.g. 12€ + 20% tax = 14.40€)')}
          />
          <FormControlLabel
            value="tax_included"
            control={<Radio />}
            label={t('Tax already included in the price (e.g. 12€ including 20% tax stays 12€)')}
          />
        </RadioGroup>
      </FormControl>

      {!canEdit && (
        <Typography variant="body2" color="text.secondary">
          {t('Changing the tax price mode requires the settings:tax:write permission.')}
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}
