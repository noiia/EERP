'use client'
import { useState } from 'react'
import Button from '@mui/material/Button'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useT, ViewBanner } from '@eerp/core-front'
import {
  savePropertyManagementSettings,
  type PropertyManagementSettings as Settings,
} from '@/lib/propertymanagement-settings'

/** Settings → Apps → Property management: what rent receipt PDFs print. */
export default function PropertyManagementSettings({ initial, canEdit }: { initial: Settings; canEdit: boolean }) {
  const t = useT()
  const [displayTaxes, setDisplayTaxes] = useState(initial.display_taxes_on_report)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save() {
    const res = await savePropertyManagementSettings({ display_taxes_on_report: displayTaxes })
    setMsg(res.ok ? { ok: true, text: t('Saved.') } : { ok: false, text: res.message || t('Could not save.') })
  }

  return (
    <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <Typography variant="h6" component="h2">{t('Rent receipts')}</Typography>
      <FormControlLabel
        control={
          <Switch
            checked={displayTaxes}
            disabled={!canEdit}
            onChange={(e) => setDisplayTaxes(e.target.checked)}
          />
        }
        label={t('Display taxes on report')}
      />
      <Typography variant="body2" color="text.secondary">
        {t('Prints the Tax column on rent receipts generated from now on. Receipts already generated keep their PDF until it is regenerated.')}
      </Typography>
      {canEdit && <Button variant="contained" onClick={() => void save()} sx={{ alignSelf: 'flex-start' }}>{t('Save')}</Button>}
      {msg && <ViewBanner status={msg.ok ? 'info' : 'error'}>{msg.text}</ViewBanner>}
    </Stack>
  )
}
