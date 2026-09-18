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
import { setUnitSettings, type UnitSettings, type UnitSystem } from '@/lib/unit-settings'

// Settings -> Global settings -> Units: the workspace-wide default unit
// system — metric or imperial. propertymanagement's own property Create
// override reads this SAME setting server-side to pick a sensible starting
// floor_area uom (square meter vs. square foot) for a NEW property; it never
// forces the choice afterward — uom_id stays freely re-pickable from the
// surface-only catalog (property_management_views.ts's own `uom_id` field).
// Same save-on-change shape as TaxSettings; a single radio choice needs no
// separate Save button.
export default function UnitSettings({
  canEdit,
  initialSettings,
}: {
  canEdit: boolean
  initialSettings: UnitSettings
}) {
  const t = useT()
  const [system, setSystem] = useState<UnitSystem>(initialSettings.system)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: UnitSystem) {
    setError(null)
    setSaving(true)
    const result = await setUnitSettings({ system: next })
    setSaving(false)
    if (!result.ok) setError(result.message)
  }

  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        {t(
          'Decides the default unit system new records start with — e.g. property management’s floor area, seeded square meters or square feet accordingly. Never forces an already-picked unit; every unit picker stays freely re-selectable.',
        )}
      </Typography>

      <FormControl disabled={!canEdit || saving}>
        <RadioGroup
          value={system}
          onChange={(e) => {
            const next = e.target.value as UnitSystem
            setSystem(next)
            void save(next)
          }}
        >
          <FormControlLabel value="metric" control={<Radio />} label={t('Metric (meters, kilograms, liters)')} />
          <FormControlLabel
            value="imperial"
            control={<Radio />}
            label={t('Imperial (feet, pounds, gallons)')}
          />
        </RadioGroup>
      </FormControl>

      {!canEdit && (
        <Typography variant="body2" color="text.secondary">
          {t('Changing the default unit system requires the settings:units:write permission.')}
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}
