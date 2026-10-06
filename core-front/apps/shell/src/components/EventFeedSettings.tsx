'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { createMyEventFeed, revokeMyEventFeed } from '@/lib/event-settings'

/** Settings → Account: the caller's private calendar feed of every event session
 * and appointment, to subscribe to from Outlook, Google or Apple Calendar. The
 * link is the credential: it's shown once, and replacing it kills the old one. */
export default function EventFeedSettings({ enabled }: { enabled: boolean }) {
  const t = useT()
  const [on, setOn] = useState(enabled)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  async function create() {
    const res = await createMyEventFeed()
    if (!res.ok) return setError(res.message || t('Could not save.'))
    setError('')
    setOn(true)
    setUrl(window.location.origin + res.path)
  }
  async function revoke() {
    if (await revokeMyEventFeed()) {
      setOn(false)
      setUrl('')
    } else setError(t('Could not save.'))
  }

  return (
    <Stack spacing={2} sx={{ maxWidth: 640 }}>
      <Typography variant="h6" component="h2">{t('Events calendar feed')}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t('Subscribe to every event session and appointment from your calendar app. Keep the link private: anyone with it can read the schedule.')}
      </Typography>
      {url && (
        <>
          <TextField id="event-feed-url" label={t('Calendar link')} value={url} slotProps={{ htmlInput: { readOnly: true } }}
            onFocus={(e) => e.target.select()} />
          <Alert severity="info">{t('Copy it now: it is not shown again.')}</Alert>
        </>
      )}
      <Stack direction="row" spacing={1}>
        <Button variant="contained" onClick={() => void create()}>
          {on ? t('Replace my calendar link') : t('Create my calendar link')}
        </Button>
        {on && <Button variant="outlined" color="error" onClick={() => void revoke()}>{t('Stop the link')}</Button>}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}
