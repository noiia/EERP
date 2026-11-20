'use client'
import { useState } from 'react'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useT, ViewBanner } from '@eerp/core-front'
import { decideAuthorization, type AuthorizeCheck } from '@/lib/mcp-oauth'

/** Only ever leave for the callback Go validated against the app's registered ones: an https
 * URL, or a loopback one (http://localhost…, a native app such as Claude Code, RFC 8252). */
export function safeCallback(to: string): boolean {
  try {
    const u = new URL(to)
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  } catch {
    return false
  }
}

function leave(to: string) {
  if (safeCallback(to)) window.location.assign(to)
}

/** The consent screen an MCP client (claude.ai, ChatGPT) sends the user to
 * (ADR-043): which app asks, where it comes from, and Allow / Deny. The app's
 * name is whatever it claims, so its host is shown beside it. */
export default function OAuthConsent({ check, params }: { check: AuthorizeCheck | null; params: Record<string, string> }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function answer(approve: boolean) {
    setBusy(true)
    setError('')
    const res = await decideAuthorization(params, approve)
    if (res?.redirect_to) return leave(res.redirect_to)
    setBusy(false)
    setError(res && !res.ok ? res.error_description : t('EERP could not be reached. Try again.'))
  }

  let body
  if (!check) {
    body = <ViewBanner status="error">{t('Connecting apps to EERP is not enabled on this server.')}</ViewBanner>
  } else if (!check.ok) {
    body = (
      <Stack spacing={2}>
        <ViewBanner status="error">{check.error_description}</ViewBanner>
        {check.redirect_to && (
          <Button variant="outlined" onClick={() => leave(check.redirect_to!)}>{t('Return to the application')}</Button>
        )}
      </Stack>
    )
  } else {
    body = (
      <Stack spacing={2}>
        <Typography>
          {t('{app} wants to use EERP on your behalf, through its MCP connector.').replace('{app}', check.client_name)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('Request from {host}. It will see and do only what your own roles allow, until you revoke it in Settings → Account.').replace('{host}', check.client_host)}
        </Typography>
        {error && <ViewBanner status="error">{error}</ViewBanner>}
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button disabled={busy} onClick={() => void answer(false)}>{t('Deny')}</Button>
          <Button variant="contained" disabled={busy} onClick={() => void answer(true)}>{t('Allow')}</Button>
        </Stack>
      </Stack>
    )
  }
  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <Card>
        <CardContent>
          <Typography variant="h5" component="h1" sx={{ mb: 2 }}>
            {check?.ok ? t('Connect {app}?').replace('{app}', check.client_name) : t('Connect an app')}
          </Typography>
          {body}
        </CardContent>
      </Card>
    </Container>
  )
}
