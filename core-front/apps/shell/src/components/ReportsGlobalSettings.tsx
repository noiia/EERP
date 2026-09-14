'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { setReportsLayout } from '@/lib/report-settings'

// Settings -> Global settings -> Reports: the workspace-wide PDF report
// letterhead. Footer/address are stamped on EVERY generated report (docs/
// roadmaps/pdf-reports.md), additive to whatever a report's own layout
// already prints — unlike PictureSizeSettings there is no override toggle,
// this IS the base value every report_page_format may itself override.
export default function ReportsGlobalSettings({
  canEdit,
  initialFooter,
  initialAddress,
}: {
  canEdit: boolean
  initialFooter: string
  initialAddress: string
}) {
  const t = useT()
  const [footer, setFooter] = useState(initialFooter)
  const [address, setAddress] = useState(initialAddress)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: { footer: string; address: string }) {
    setError(null)
    setSaving(true)
    const result = await setReportsLayout(next)
    setSaving(false)
    if (!result.ok) setError(result.message)
  }

  const disabled = !canEdit || saving

  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        {t('Footer and address text stamped on every generated PDF report, unless a page format below overrides it.')}
      </Typography>

      <TextField
        label={t('Footer')}
        multiline
        minRows={2}
        disabled={disabled}
        value={footer}
        onChange={(e) => setFooter(e.target.value)}
        onBlur={() => void save({ footer, address })}
      />
      <TextField
        label={t('Address')}
        multiline
        minRows={2}
        disabled={disabled}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        onBlur={() => void save({ footer, address })}
      />

      {!canEdit && (
        <Typography variant="body2" color="text.secondary">
          {t('Changing the reports letterhead requires the settings:reports:write permission.')}
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}
