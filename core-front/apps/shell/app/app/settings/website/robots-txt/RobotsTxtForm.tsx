'use client'
import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { previewSiteFile, saveRobotsExtra } from '@/lib/website-settings'

// Settings → Website → robots.txt: the ERP, API and visitor pages are always
// disallowed (and the whole ERP host in host routing mode); these lines are added after.
export default function RobotsTxtForm({ initial }: { initial: string }) {
  const t = useT()
  const [extra, setExtra] = useState(initial)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [preview, setPreview] = useState('')

  useEffect(() => {
    void previewSiteFile('robots.txt').then(setPreview)
  }, [])

  async function save() {
    const res = await saveRobotsExtra(extra)
    setMsg(
      res.ok
        ? { ok: true, text: t('Saved.') }
        : { ok: false, text: res.message || t('Could not save.') },
    )
    if (res.ok) setPreview(await previewSiteFile('robots.txt'))
  }

  return (
    <Stack spacing={2} sx={{ maxWidth: 720 }}>
      <TextField
        label={t('Additional rules')}
        placeholder={'Disallow: /drafts\nSitemap: https://www.example.com/sitemap.xml'}
        multiline
        minRows={4}
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        helperText={t(
          'Appended after the built-in rules, which keep crawlers out of the ERP, the API and visitor pages.',
        )}
        slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
      />
      <Button variant="contained" onClick={() => void save()} sx={{ alignSelf: 'flex-start' }}>
        {t('Save')}
      </Button>
      {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      <Typography variant="subtitle2">{t('Served file (for this address)')}</Typography>
      <Typography
        component="pre"
        variant="body2"
        sx={{ m: 0, p: 2, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto' }}
      >
        {preview}
      </Typography>
    </Stack>
  )
}
