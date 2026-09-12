'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { setUsernameAtFormat } from '@/lib/preferences'

// Settings -> Global settings -> Accounts: the workspace-wide switch deciding
// whether a `text/username` field always renders with a leading "@" (like a
// handle) — a pure display choice, never rewriting the stored username. Same
// save-on-change shape as TaxSettings/OSMConnectorSettings.
export default function AccountsSettings({
  canEdit,
  initialUsernameAtFormat,
}: {
  canEdit: boolean
  initialUsernameAtFormat: boolean
}) {
  const t = useT()
  const [checked, setChecked] = useState(initialUsernameAtFormat)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: boolean) {
    setError(null)
    setSaving(true)
    const result = await setUsernameAtFormat(next)
    setSaving(false)
    if (!result.ok) setError(result.message)
  }

  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        {t(
          'Decides whether usernames always render with a leading "@" (like a handle) across the workspace. The stored username itself is never changed.',
        )}
      </Typography>

      <FormControlLabel
        disabled={!canEdit || saving}
        control={
          <Switch
            checked={checked}
            onChange={(e) => {
              const next = e.target.checked
              setChecked(next)
              void save(next)
            }}
          />
        }
        label={t('Display usernames with a leading "@"')}
      />

      {!canEdit && (
        <Typography variant="body2" color="text.secondary">
          {t('Changing the username display format requires the settings:accounts:write permission.')}
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}
