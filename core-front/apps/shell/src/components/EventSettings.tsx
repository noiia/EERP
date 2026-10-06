'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { erpPath, useT } from '@eerp/core-front'
import Link from '@mui/material/Link'
import { saveEventSettings, type EventSettings as Settings } from '@/lib/event-settings'

/** Settings → Apps → Events: the workspace's booking reminder delay. */
export default function EventSettings({ initial, canEdit }: { initial: Settings; canEdit: boolean }) {
  const t = useT()
  const [hours, setHours] = useState(String(initial.reminder_hours))
  const [claimHours, setClaimHours] = useState(String(initial.waitlist_claim_hours))
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save() {
    const res = await saveEventSettings({ reminder_hours: Number(hours), waitlist_claim_hours: Number(claimHours) })
    setMsg(res.ok ? { ok: true, text: t('Saved.') } : { ok: false, text: res.message || t('Could not save.') })
  }

  return (
    <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <Typography variant="h6" component="h2">{t('Reminders')}</Typography>
      <TextField id="event-reminder-hours" type="number" label={t('Send the reminder email this many hours before the start (0 = no reminders)')}
        value={hours} disabled={!canEdit} slotProps={{ htmlInput: { min: 0, max: 720 } }}
        onChange={(e) => setHours(e.target.value)} />
      <Typography variant="body2" color="text.secondary">
        {t('Bookings made less than that before the start get no reminder: their confirmation is recent enough.')}{' '}
        <Link href={erpPath('/settings/email-templates')}>{t('Edit the email texts')}</Link>
      </Typography>
      <Typography variant="h6" component="h2">{t('Waiting list')}</Typography>
      <TextField id="event-claim-hours" type="number" label={t('Hours a freed seat stays reserved for the next person on the waiting list')}
        value={claimHours} disabled={!canEdit} slotProps={{ htmlInput: { min: 1, max: 168 } }}
        onChange={(e) => setClaimHours(e.target.value)} />
      {canEdit && <Button variant="contained" onClick={() => void save()} sx={{ alignSelf: 'flex-start' }}>{t('Save')}</Button>}
      {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
    </Stack>
  )
}
