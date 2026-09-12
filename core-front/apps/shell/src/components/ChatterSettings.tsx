'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { effectiveChatterVisible, useT, type ChatterVisibilityConfig } from '@eerp/core-front'
import { setEntityChatterVisibility } from '@/lib/chatter-visibility'

// Settings -> Apps -> :module: whether each of this app's forms renders the
// chatter panel ("Form chatter panel" row) — true by design unless the
// module itself declares a hardcoded `showChatter: false` (e.g. App Store's
// own read-only management form), and always overridable per entity from
// here. The durable value is server state (app_settings key
// views.<entity>.chatter, PUT /settings/views/:entity/chatter, permission
// settings:views:write) — this component holds only the optimistic
// client-side mirror the page seeded it with.

export interface ChatterEntityRow {
  entity: string
  /** ViewDescriptor.showChatter, undefined = the module declared no opinion
   * (defaults to true). */
  moduleDefault: boolean | undefined
  config: ChatterVisibilityConfig
}

export default function ChatterSettings({
  rows: initialRows,
  canEdit,
}: {
  rows: ChatterEntityRow[]
  canEdit: boolean
}) {
  const t = useT()
  const [rows, setRows] = useState(initialRows)
  const [error, setError] = useState<string | null>(null)

  async function toggle(entity: string, enabled: boolean) {
    const previous = rows
    setError(null)
    setRows((rs) => rs.map((r) => (r.entity === entity ? { ...r, config: { enabled } } : r)))
    const result = await setEntityChatterVisibility(entity, enabled)
    if (!result.ok) {
      setRows(previous)
      setError(result.message)
    }
  }

  if (rows.length === 0) return null

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle1">{t('Chatter panel')}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t('Whether each form shows its activity feed (comments and change log) beside/below the record.')}
      </Typography>
      <Stack spacing={1}>
        {rows.map((row) => {
          const effective = effectiveChatterVisible(row.moduleDefault, row.config)
          return (
            <Stack key={row.entity} spacing={0.25}>
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={effective}
                    disabled={!canEdit}
                    onChange={(e) => void toggle(row.entity, e.target.checked)}
                  />
                }
                label={row.entity}
              />
              {row.moduleDefault !== undefined && row.config.enabled != null && (
                <Typography variant="caption" color="text.secondary" sx={{ ml: 4.5 }}>
                  {t('The module defaults this to')} {row.moduleDefault ? t('on') : t('off')}.
                </Typography>
              )}
            </Stack>
          )
        })}
      </Stack>
      {!canEdit && (
        <Typography variant="body2" color="text.secondary">
          {t('Changing chatter visibility requires the settings:views:write permission.')}
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}
