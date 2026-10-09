'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { saveLegal, type LegalNotice } from '@/lib/website-settings'

type Field = { key: keyof LegalNotice; label: string; multiline?: boolean; type?: string }

const PUBLISHER: Field[] = [
  { key: 'company_name', label: 'Company name' },
  { key: 'legal_form', label: 'Legal form' },
  { key: 'share_capital', label: 'Share capital' },
  { key: 'address', label: 'Registered office', multiline: true },
  { key: 'registration', label: 'Registration (SIRET / RCS)' },
  { key: 'vat_number', label: 'VAT number' },
  { key: 'publication_director', label: 'Publication director' },
  { key: 'contact_email', label: 'Email', type: 'email' },
  { key: 'contact_phone', label: 'Phone', type: 'tel' },
]
const HOSTING: Field[] = [
  { key: 'host_name', label: 'Host' },
  { key: 'host_address', label: 'Address', multiline: true },
  { key: 'host_phone', label: 'Phone', type: 'tel' },
]

// Settings → Website → Legal notice: shown on the site at /legal-notice (footer
// link) and in the ERP at /app/legal-notice. Leaving every field empty hides it.
export default function LegalForm({ initial }: { initial: LegalNotice }) {
  const t = useT()
  const [l, setL] = useState(initial)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save() {
    const res = await saveLegal(l)
    setMsg(
      res.ok
        ? { ok: true, text: t('Saved.') }
        : { ok: false, text: res.message || t('Could not save.') },
    )
  }

  const fields = (list: Field[]) =>
    list.map((f) => (
      <TextField
        key={f.key}
        label={t(f.label)}
        type={f.type}
        multiline={f.multiline}
        minRows={f.multiline ? 2 : undefined}
        value={l[f.key]}
        onChange={(e) => setL({ ...l, [f.key]: e.target.value })}
      />
    ))

  return (
    <Stack spacing={2} sx={{ maxWidth: 720 }}>
      <Typography variant="h6" component="h2">
        {t('Publisher')}
      </Typography>
      {fields(PUBLISHER)}
      <Typography variant="h6" component="h2">
        {t('Hosting')}
      </Typography>
      {fields(HOSTING)}
      <TextField
        label={t('Additional text (privacy, cookies, credits…)')}
        multiline
        minRows={6}
        value={l.extra_text}
        onChange={(e) => setL({ ...l, extra_text: e.target.value })}
      />
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Button variant="contained" onClick={() => void save()}>
          {t('Save')}
        </Button>
        <Link href="/legal-notice" target="_blank" rel="noopener">
          {t('View on the website')}
        </Link>
      </Stack>
      {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
    </Stack>
  )
}
