'use client'
import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { previewSiteFile, saveSecurityTxt, type SecurityTxt } from '@/lib/website-settings'

// RFC 3339 <-> the datetime-local input (local time, no zone).
const toLocal = (iso: string) => {
  const d = new Date(iso)
  if (!iso || isNaN(d.getTime())) return ''
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
const fromLocal = (v: string) => (v ? new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z') : '')

// Settings → Website → security.txt: RFC 9116, served at /.well-known/security.txt
// and /security.txt. No contact = not served; past its expiry Go stops serving it.
export default function SecurityTxtForm({ initial }: { initial: SecurityTxt }) {
  const t = useT()
  const [s, setS] = useState(initial)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [preview, setPreview] = useState('')

  useEffect(() => {
    void previewSiteFile('security.txt').then(setPreview)
  }, [])

  async function save() {
    const res = await saveSecurityTxt(s)
    setMsg(
      res.ok
        ? { ok: true, text: t('Saved.') }
        : { ok: false, text: res.message || t('Could not save.') },
    )
    if (res.ok) setPreview(await previewSiteFile('security.txt'))
  }

  const text = (
    key: Exclude<keyof SecurityTxt, 'contacts' | 'expires'>,
    label: string,
    placeholder: string,
  ) => (
    <TextField
      label={t(label)}
      placeholder={placeholder}
      value={s[key]}
      onChange={(e) => setS({ ...s, [key]: e.target.value })}
    />
  )

  return (
    <Stack spacing={2} sx={{ maxWidth: 720 }}>
      <TextField
        label={t('Contacts (one per line)')}
        placeholder={'mailto:security@example.com\nhttps://example.com/security'}
        multiline
        minRows={2}
        value={s.contacts.join('\n')}
        onChange={(e) => setS({ ...s, contacts: e.target.value.split('\n') })}
        helperText={t('mailto:, tel: or https:// addresses. Leave empty to stop serving the file.')}
      />
      <TextField
        label={t('Expires')}
        type="datetime-local"
        value={toLocal(s.expires)}
        onChange={(e) => setS({ ...s, expires: fromLocal(e.target.value) })}
        helperText={t('At most a year away. Renew it before then, or the file stops being served.')}
        slotProps={{ inputLabel: { shrink: true } }}
      />
      {text('policy', 'Policy URL', 'https://example.com/security-policy')}
      {text('acknowledgments', 'Acknowledgments URL', 'https://example.com/hall-of-fame')}
      {text('encryption', 'Encryption key URL', 'https://example.com/pgp-key.txt')}
      {text('preferred_languages', 'Preferred languages', 'en, fr')}
      <Button variant="contained" onClick={() => void save()} sx={{ alignSelf: 'flex-start' }}>
        {t('Save')}
      </Button>
      {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      <Typography variant="subtitle2">{t('Served file')}</Typography>
      <Typography
        component="pre"
        variant="body2"
        sx={{ m: 0, p: 2, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto' }}
      >
        {preview || t('Not served.')}
      </Typography>
    </Stack>
  )
}
