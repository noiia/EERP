'use client'
import { useState } from 'react'
import Button from '@mui/material/Button'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useT, ViewBanner } from '@eerp/core-front'
import { saveWarehouseSettings, type WarehouseSettings as Settings } from '@/lib/warehouse-settings'

/** Settings → Apps → Warehouse: how product references are made. */
export default function WarehouseSettings({ initial, canEdit }: { initial: Settings; canEdit: boolean }) {
  const t = useT()
  const [auto, setAuto] = useState(initial.auto_reference)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save() {
    const res = await saveWarehouseSettings({ auto_reference: auto })
    setMsg(res.ok ? { ok: true, text: t('Saved.') } : { ok: false, text: res.message || t('Could not save.') })
  }

  return (
    <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <Typography variant="h6" component="h2">{t('Products')}</Typography>
      <FormControlLabel
        control={<Switch checked={auto} disabled={!canEdit} onChange={(e) => setAuto(e.target.checked)} />}
        label={t('Generate references automatically')}
      />
      <Typography variant="body2" color="text.secondary">
        {t('On: each new product gets the next reference (PRD-00001, PRD-00002…), which cannot be edited. Off: references are typed by hand.')}
      </Typography>
      {canEdit && <Button variant="contained" onClick={() => void save()} sx={{ alignSelf: 'flex-start' }}>{t('Save')}</Button>}
      {msg && <ViewBanner status={msg.ok ? 'info' : 'error'}>{msg.text}</ViewBanner>}
    </Stack>
  )
}
