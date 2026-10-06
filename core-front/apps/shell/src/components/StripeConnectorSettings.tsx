'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { saveStripeSettings, type StripeStatus } from '@/lib/stripe-settings'

/** Settings → Global settings → Integrations: Stripe online payment (event
 * bookings). Connected = the Stripe payments app is active AND enabled here
 * with both keys; otherwise paid bookings are paid at the event. Keys are
 * write-only: a blank field keeps the saved key. */
export default function StripeConnectorSettings({ canEdit, initial, webhookURL }: {
  canEdit: boolean
  initial: StripeStatus
  /** The address to register as the Stripe webhook endpoint. */
  webhookURL: string
}) {
  const t = useT()
  const [enabled, setEnabled] = useState(initial.enabled)
  const [secretKey, setSecretKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save() {
    const res = await saveStripeSettings({ enabled, secret_key: secretKey, webhook_secret: webhookSecret })
    if (res.ok) {
      setSecretKey('')
      setWebhookSecret('')
    }
    setMsg(res.ok ? { ok: true, text: t('Saved.') } : { ok: false, text: res.message || t('Could not save.') })
  }

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2">Stripe</Typography>
      <Typography color="text.secondary">
        {t('Takes card payments for paid event bookings through Stripe Checkout. Without it, bookings are paid at the event.')}
      </Typography>
      {!initial.active && <Alert severity="warning">{t('Activate the Stripe payments app (Settings → Apps) for these settings to take effect.')}</Alert>}
      <FormControlLabel control={<Switch checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} />}
        label={t('Take payments online')} />
      <TextField id="stripe-secret-key" type="password" label={t('Secret key (sk_…)')} value={secretKey} disabled={!canEdit}
        autoComplete="off" onChange={(e) => setSecretKey(e.target.value)}
        helperText={initial.secret_key_set ? t('A secret key is saved; leave blank to keep it.') : undefined} />
      <TextField id="stripe-webhook-secret" type="password" label={t('Webhook signing secret (whsec_…)')} value={webhookSecret}
        disabled={!canEdit} autoComplete="off" onChange={(e) => setWebhookSecret(e.target.value)}
        helperText={initial.webhook_secret_set ? t('A signing secret is saved; leave blank to keep it.') : undefined} />
      <Typography variant="body2" color="text.secondary">
        {t('In the Stripe dashboard, add a webhook endpoint for the checkout.session.completed and checkout.session.expired events at:')}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{webhookURL}</Typography>
      {canEdit && <Button variant="contained" onClick={() => void save()} sx={{ alignSelf: 'flex-start' }}>{t('Save')}</Button>}
      {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
    </Stack>
  )
}
