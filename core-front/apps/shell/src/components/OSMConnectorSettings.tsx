'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { setOSMConnector, type OSMConnector } from '@/lib/osm-settings'

// Settings -> Global settings -> Integrations: the workspace's OpenStreetMap
// (Nominatim) connector, used to autocomplete addresses as the user types
// into a type: 'address' field (AddressWidget, @eerp/core-front). Disabled
// (the default) means the address widget degrades to plain manual entry —
// same "render inert, not a crash" posture every other optional connector
// takes. Same save-on-blur/save-on-toggle shape as ReportsGlobalSettings.
export default function OSMConnectorSettings({
  canEdit,
  initialConnector,
}: {
  canEdit: boolean
  initialConnector: OSMConnector
}) {
  const t = useT()
  const [enabled, setEnabled] = useState(initialConnector.enabled)
  const [baseURL, setBaseURL] = useState(initialConnector.base_url)
  const [userAgent, setUserAgent] = useState(initialConnector.user_agent)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: OSMConnector) {
    setError(null)
    setSaving(true)
    const result = await setOSMConnector(next)
    setSaving(false)
    if (!result.ok) setError(result.message)
  }

  const disabled = !canEdit || saving

  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        {t(
          'Autocompletes addresses as the user types into an Address field, via a Nominatim-compatible OpenStreetMap search endpoint.',
        )}
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={enabled}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.checked
              setEnabled(next)
              void save({ enabled: next, base_url: baseURL, user_agent: userAgent })
            }}
          />
        }
        label={t('Enabled')}
      />
      <TextField
        label={t('Base URL')}
        placeholder="https://nominatim.openstreetmap.org"
        disabled={disabled}
        value={baseURL}
        onChange={(e) => setBaseURL(e.target.value)}
        onBlur={() => void save({ enabled, base_url: baseURL, user_agent: userAgent })}
      />
      <TextField
        label={t('User agent')}
        helperText={t('Required by Nominatim’s usage policy — identify your app (e.g. "eerp/1.0 (you@example.com)").')}
        disabled={disabled}
        value={userAgent}
        onChange={(e) => setUserAgent(e.target.value)}
        onBlur={() => void save({ enabled, base_url: baseURL, user_agent: userAgent })}
      />

      {!canEdit && (
        <Typography variant="body2" color="text.secondary">
          {t('Changing the OpenStreetMap connector requires the settings:integrations:write permission.')}
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}
