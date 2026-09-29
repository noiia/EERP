'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { useT } from '@eerp/core-front'
import { saveRouting, type Routing } from '@/lib/website-settings'

export default function RoutingForm({ initial }: { initial: Routing }) {
  const t = useT()
  const [r, setR] = useState(initial)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save() {
    const res = await saveRouting(r)
    setMsg(res.ok ? { ok: true, text: t('Saved.') } : { ok: false, text: res.message || t('Could not save.') })
  }

  return (
    <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <RadioGroup value={r.mode} onChange={(e) => setR({ ...r, mode: e.target.value as Routing['mode'] })}>
        <FormControlLabel value="path" control={<Radio />} label={t('Path — the website lives under the ERP address')} />
        <FormControlLabel value="host" control={<Radio />} label={t('Host — the website has its own domain')} />
      </RadioGroup>
      {r.mode === 'host' && (
        <>
          <TextField label={t('Website host')} placeholder="www.example.com" value={r.site_host} onChange={(e) => setR({ ...r, site_host: e.target.value })} />
          <TextField label={t('ERP host')} placeholder="erp.example.com" value={r.erp_host} onChange={(e) => setR({ ...r, erp_host: e.target.value })} />
          <Alert severity="warning">
            {t(
              'To avoid locking yourself out, save this from the ERP address you are entering, e.g. https://erp.example.com/app/settings/website/routing. To recover, set the environment variable EERP_SITE_ROUTING=path.',
            )}
          </Alert>
        </>
      )}
      <Button variant="contained" onClick={() => void save()} sx={{ alignSelf: 'flex-start' }}>
        {t('Save')}
      </Button>
      {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
    </Stack>
  )
}
